@echo off
cd /d "C:\Users\kai\Documents\leeds-telemetry\scraper"
set /p EVENT="Paste the event ID and press Enter: "
python scraper.py --event %EVENT% --full --output ../dashboard/public
echo.
echo Finished. Refresh the dashboard and load event %EVENT%.
cmd /k
