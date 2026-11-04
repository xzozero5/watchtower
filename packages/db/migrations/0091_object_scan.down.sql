-- Reverts 0091. Lossy on purpose: the scan results go away. Files are untouched; with UPLOAD_SCAN=clamav
-- the worker enrols and scans them all again once the migration is applied again (and until then the api
-- would refuse to serve them, so set UPLOAD_SCAN=off before reverting).
DROP TABLE IF EXISTS object_scan;
