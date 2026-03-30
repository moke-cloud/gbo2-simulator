@echo off
cd /d "C:\Users\zeroz\.antigravity\gbo2-simulator"

echo [%date% %time%] 更新開始 >> tools\update_log.txt

python tools\update.py --mode weekly >> tools\update_log.txt 2>&1

git diff --quiet data\ || (
    git add data\ms_data.json data\ms_url_list.json data\custom_parts.json data\enhancement_skills.json
    git commit -m "chore: update MS data (%date%)"
    git push
    echo [%date% %time%] push完了 >> tools\update_log.txt
)

echo [%date% %time%] 終了 >> tools\update_log.txt
