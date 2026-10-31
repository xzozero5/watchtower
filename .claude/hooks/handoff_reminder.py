"""Stop hook: remind the main thread to run /handoff when HANDOFF.md or today's daily log were not touched this session.
Prints a reminder on stdout (non-blocking, exit 0). Bangkok time for the daily log filename."""
import datetime, os, sys, time
try:
    from zoneinfo import ZoneInfo
    now = datetime.datetime.now(ZoneInfo("Asia/Bangkok"))
except Exception:
    now = datetime.datetime.utcnow() + datetime.timedelta(hours=7)
proj = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
daily = os.path.join(proj, "logs", "daily", now.strftime("%Y-%m-%d") + ".md")
handoff = os.path.join(proj, "HANDOFF.md")
msgs = []
if not os.path.exists(daily):
    msgs.append(f"- daily log วันนี้ยังไม่มี: logs/daily/{now:%Y-%m-%d}.md (เวลากรุงเทพ)")
def stale(p, hours=3):
    return (not os.path.exists(p)) or (time.time() - os.path.getmtime(p) > hours * 3600)
if stale(handoff):
    msgs.append("- HANDOFF.md ไม่ถูกแตะใน ~3 ชม. — ถ้า session นี้เปลี่ยนสถานะ ให้รัน /handoff")
if msgs:
    print("⚠️ ก่อนจบ session:\n" + "\n".join(msgs))
sys.exit(0)
