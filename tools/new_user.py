#!/usr/bin/env python3
"""יוצר קוד אישי חדש למשתמש.   python3 tools/new_user.py dana
מדפיס זוג  name:code  שמוסיפים למשתנה NAKDAN_USERS ב-Railway (זוגות מופרדים בפסיק)."""
import secrets, sys
ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'          # no look-alikes (0/o, 1/l/i)
name = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
if not name or ':' in name or ',' in name:
    sys.exit('usage: python3 tools/new_user.py <name-in-english>')
code = '-'.join(''.join(secrets.choice(ALPHABET) for _ in range(4)) for _ in range(3))
print(f'{name}:{code}')
