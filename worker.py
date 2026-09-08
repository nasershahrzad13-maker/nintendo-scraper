import os
import sys
import re
import requests
import yt_dlp
import tempfile
import time

import subprocess
import json

# متغیرهای محیطی دریافتی از گیت‌هاب یا فایل .env
SITE_URL = os.environ.get("SITE_URL", "https://your-domain.com").rstrip("/")
SYNC_API_TOKEN = os.environ.get("SYNC_API_TOKEN", "ninten2-sync-secret-key-2026")
YOUTUBE_COOKIES_DATA = os.environ.get("YOUTUBE_COOKIES", "")
ABREHAMRAHI_REFRESH_TOKEN = os.environ.get("ABREHAMRAHI_REFRESH_TOKEN", "")

def get_pending_videos():
    url = f"{SITE_URL}/api/v1/sync/pending-videos"
    headers = {
        "X-SYNC-TOKEN": SYNC_API_TOKEN,
        "Accept": "application/json"
    }
    try:
        print(f"📡 دریافت لیست ویدیوهای در انتظار از: {url}")
        res = requests.get(url, headers=headers, timeout=15)
        if res.status_code == 200:
            data = res.json()
            return data.get("data", [])
        else:
            print(f"❌ خطای سرور ({res.status_code}): {res.text}")
            return []
    except Exception as e:
        print(f"❌ خطا در اتصال به سایت: {e}")
        return []

def download_video(url, output_dir, cookie_path=None):
    os.makedirs(output_dir, exist_ok=True)
    
    # تبدیل لینک به فرمت استاندارد watch
    match = re.search(r"(?:v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})", url)
    target_url = f"https://www.youtube.com/watch?v={match.group(1)}" if match else url

    print(f"🎬 در حال دانلود ویدیو از: {target_url}")
    
    ydl_opts = {
        # اولویت کیفیت 480p کم‌حجم و بهینه (کاهش چشمگیر حجم فایل و سرعت پخش بالا)
        'format': 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=720][ext=mp4]/best',
        'outtmpl': os.path.join(output_dir, '%(id)s.%(ext)s'),
        'quiet': False,
        'no_warnings': False,
        'remote_components': ['ejs:github'],
        'extractor_args': {
            'youtube': {
                'player_client': ['android', 'ios', 'tv_embedded', 'web_creator', 'web'],
                'player_skip': ['webpage', 'configs'],
            }
        },
        'age_limit': 99,
    }

    # در صورت وجود فایل کوکی اختصاصی
    if cookie_path and os.path.exists(cookie_path):
        print(f"🍪 استفاده از فایل کوکی: {cookie_path}")
        ydl_opts['cookiefile'] = cookie_path

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target_url, download=True)
            video_id = info.get('id')
            title = info.get('title')
            ext = info.get('ext', 'mp4')
            file_path = os.path.join(output_dir, f"{video_id}.{ext}")
            
            print(f"\n✅ دانلود با موفقیت کامل شد!")
            print(f"📌 عنوان: {title}")
            print(f"📁 مسیر ذخیره: {file_path}")
            return file_path
    except Exception as e:
        print(f"❌ خطا در دانلود ویدیو: {e}")
        return None

def upload_to_hamrahi(file_path, folder_name="Videos"):
    """Upload downloaded video to AbreHamrahi Cloud using hamrahi_uploader.cjs"""
    if not ABREHAMRAHI_REFRESH_TOKEN:
        print("❌ خطا: متغیر محیطی ABREHAMRAHI_REFRESH_TOKEN تنظیم نشده است.")
        return None

    current_dir = os.path.dirname(os.path.abspath(__file__))
    uploader_script = os.path.join(current_dir, "hamrahi_uploader.cjs")

    if not os.path.exists(uploader_script):
        print(f"❌ خطا: اسکریپت آپلودر ابر همراهی یافت نشد: {uploader_script}")
        return None

    file_size_mb = os.path.getsize(file_path) / (1024 * 1024)
    print(f"☁️ در حال آپلود ویدیو ({file_size_mb:.2f} MB) در پوشه {folder_name} ابر همراهی...")

    try:
        cmd = [
            "node",
            uploader_script,
            "--refresh-token", ABREHAMRAHI_REFRESH_TOKEN,
            "--file", file_path,
            "--folder", folder_name,
            "--concurrency", "4"
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        output = proc.stdout

        # Find public link from uploader output
        match = re.search(r"Public Link:\s*(https?://[^\s\n]+)", output)
        if match:
            public_url = match.group(1).strip()
            print(f"🔗 لینک مستقیم ابر همراهی دریافت شد: {public_url}")
            return public_url
        else:
            print(f"⚠️ آپلود انجام شد اما لینک پابلیک استخراج نشد. خروجی:\n{output}")
            return None
    except subprocess.CalledProcessError as e:
        print(f"❌ خطای آپلود در ابر همراهی (exit {e.returncode}):\n{e.stderr or e.stdout}")
        return None
    except Exception as e:
        print(f"❌ خطای غیرمنتظره در ارتباط با آپلودر همراهی: {e}")
        return None

def save_video_link_to_site(item_type, item_id, public_url):
    """Send public URL to website API to update database"""
    url = f"{SITE_URL}/api/v1/sync/save-video-url"
    headers = {
        "X-SYNC-TOKEN": SYNC_API_TOKEN,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    data = {
        "type": item_type,
        "id": item_id,
        "public_url": public_url
    }

    print(f"📡 ارسال لینک ویدیو به سایت: {url}")
    try:
        res = requests.post(url, headers=headers, json=data, timeout=30)
        if res.status_code == 200:
            print(f"✅ لینک ویدیو با موفقیت در دیتابیس سایت ثبت شد: {public_url}")
            return True
        else:
            print(f"❌ خطای ثبت در سایت ({res.status_code}): {res.text}")
            return False
    except Exception as e:
        print(f"❌ خطا در اتصال به سرور سایت: {e}")
        return False

def main():
    print("========================================")
    print("🎮 Ninten2 YouTube to AbreHamrahi Sync Worker")
    print("========================================")

    # بررسی توکن ابر همراهی
    if not ABREHAMRAHI_REFRESH_TOKEN:
        print("⚠️ هشدار: متغیر ABREHAMRAHI_REFRESH_TOKEN تنظیم نشده است. لطفاً آن را در گیت‌هاب Secrets قرار دهید.")

    # تعیین مسیر کوکی
    cookie_path = None
    if YOUTUBE_COOKIES_DATA.strip():
        cookie_file = tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.txt')
        cookie_file.write(YOUTUBE_COOKIES_DATA)
        cookie_file.close()
        cookie_path = cookie_file.name
        print("🍪 کوکی‌های یوتیوب از Secret گیت‌هاب بارگذاری شدند.")
    else:
        # جستجوی فایل کوکی در مسیرهای مختلف پروژه
        possible_cookie_paths = [
            os.path.join(os.getcwd(), "cookies.txt"),
            os.path.join(os.getcwd(), "youtube_cookies.txt"),
            os.path.join(os.path.dirname(__file__), "..", "..", "cookies.txt"),
            os.path.join(os.path.dirname(__file__), "..", "..", "youtube_cookies.txt"),
            os.path.join(os.path.dirname(__file__), "cookies.txt"),
            os.path.join(os.path.dirname(__file__), "youtube_cookies.txt"),
        ]
        for p in possible_cookie_paths:
            if os.path.exists(p):
                cookie_path = os.path.abspath(p)
                print(f"🍪 فایل کوکی شناسایی شد: {cookie_path}")
                break

    pending_list = get_pending_videos()
    if not pending_list:
        print("🎉 هیچ ویدیوی جدیدی برای دانلود وجود ندارد.")
        return

    print(f"📋 تعداد {len(pending_list)} ویدیو برای پردازش یافت شد.\n")

    with tempfile.TemporaryDirectory() as temp_dir:
        for idx, item in enumerate(pending_list, 1):
            item_type = item.get("type")
            item_id = item.get("id")
            title = item.get("title", "بدون عنوان")
            yt_url = item.get("youtube_url")

            print(f"\n[{idx}/{len(pending_list)}] پردازش: {title} (ID: {item_id}, Type: {item_type})")
            
            try:
                # ۱. دانلود ویدیو با استفاده از کوکی
                downloaded_file = download_video(yt_url, temp_dir, cookie_path)
                
                # ۲. آپلود در ابر همراهی و ثبت لینک در سایت
                if downloaded_file and os.path.exists(downloaded_file):
                    public_url = upload_to_hamrahi(downloaded_file, folder_name="Videos")
                    if public_url:
                        save_video_link_to_site(item_type, item_id, public_url)
                    else:
                        print("⚠️ آپلود در ابر همراهی ناموفق بود.")

                    # پاک کردن فایل موقت پس از آپلود
                    if os.path.exists(downloaded_file):
                        os.remove(downloaded_file)
                else:
                    print("⚠️ دانلود ویدیو ناموفق بود.")
            except Exception as e:
                print(f"❌ خطا در پردازش ویدیو {yt_url}: {e}")

            time.sleep(2)

    # پاک کردن کوکی موقت
    if cookie_path and not cookie_path.endswith("cookies.txt") and not cookie_path.endswith("youtube_cookies.txt") and os.path.exists(cookie_path):
        os.remove(cookie_path)

    print("\n🏁 فرآیند همگام‌سازی به پایان رسید.")

if __name__ == "__main__":
    main()
