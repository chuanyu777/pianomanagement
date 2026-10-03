"""真实数据库上的端到端业务冒烟：走一遍钱的主链路。"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:3000/api"
PW = os.environ["SMOKE_PW"]
failures = []


def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=25) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw


def step(label, method, path, body=None, token=None, expect=200):
    status, payload = call(method, path, body, token)
    ok = status == expect
    if not ok:
        failures.append(f"{label}: 期望 {expect} 实际 {status} {str(payload)[:200]}")
    print(f"[{'OK ' if ok else 'BAD'}] {label} -> {status}")
    return payload


print("=== 1. 首次引导 ===")
st = step("bootstrap 状态", "GET", "/bootstrap/status")
assert st["needsBootstrap"] is True, "空库应当需要引导"
step(
    "创建首位店主",
    "POST",
    "/bootstrap/owner",
    {"username": "owner", "password": PW, "displayName": "店主", "organizationName": "测试琴行"},
    expect=201,
)
step("重复引导应被拒", "POST", "/bootstrap/owner", {"username": "owner2", "password": PW, "displayName": "x"}, expect=409)

print("=== 2. 登录与鉴权 ===")
login = step("登录", "POST", "/auth/login", {"username": "owner", "password": PW})
token = login["accessToken"]
step("未带 token 访问 /users", "GET", "/users", expect=401)
me = step("auth/me", "GET", "/auth/me", token=token)
assert me["role"] == "OWNER", "角色应为 OWNER"

print("=== 3. 基础资料 ===")
step("种默认收支项目", "POST", "/items/seed-defaults", token=token, expect=201)
income_items = step("收入项清单", "GET", "/items/income", token=token)
piano = next((i for i in income_items if i["name"] == "钢琴"), None)
assert piano, "默认模板里应有「钢琴」收入项"
course = step("建课程类型", "POST", "/course-types", {"name": "钢琴主课"}, token=token, expect=201)
teacher = step("建老师", "POST", "/teachers", {"name": "张老师", "position": "钢琴"}, token=token, expect=201)
student = step("建学生", "POST", "/students", {"name": "小明", "gradeLevel": 3}, token=token, expect=201)
enroll = step(
    "报名（自定义单价 300）",
    "POST",
    "/enrollments",
    {
        "studentId": student["id"],
        "teacherId": teacher["id"],
        "courseTypeId": course["id"],
        "unitPrice": 300,
        "effectiveFrom": "2026-10-01T00:00:00.000Z",
    },
    token=token,
    expect=201,
)

print("=== 4. 交费 3000（进实收池） ===")
step(
    "记交费",
    "POST",
    "/payments",
    {
        "enrollmentId": enroll["id"],
        "amount": 3000,
        "incomeItemId": piano["id"],
        "occurredAt": "2026-10-02T02:00:00.000Z",
    },
    token=token,
    expect=201,
)
led = step("学生台账", "GET", f"/ledger/students/{student['id']}", token=token)
row = led["enrollments"][0]
print(f"     实收余额 = {row['paidBalance']}，赠送余额 = {row['giftBalance']}，状态 = {led['balanceStatus']}")
if row["paidBalance"] != "3000.00":
    failures.append(f"交费后实收余额应为 3000.00，实际 {row['paidBalance']}")

print("=== 5. 排课 → 确认（关键：扣费） ===")
lesson = step(
    "排课",
    "POST",
    "/lessons",
    {
        "studentId": student["id"],
        "teacherId": teacher["id"],
        "courseTypeId": course["id"],
        "scheduledAt": "2026-10-05T02:00:00.000Z",
        "isGift": False,
    },
    token=token,
    expect=201,
)
step(
    "确认上课（确认时间由服务端取当前时间）",
    "POST",
    f"/lessons/{lesson['id']}/confirm",
    None,
    token=token,
    expect=201,
)
led2 = step("确认后台账", "GET", f"/ledger/students/{student['id']}", token=token)
row2 = led2["enrollments"][0]
print(f"     实收余额 = {row2['paidBalance']}（应为 2700.00），剩余课时 = {row2.get('remainingLessons')}")
if row2["paidBalance"] != "2700.00":
    failures.append(f"确认后实收余额应为 2700.00，实际 {row2['paidBalance']}")

step("重复确认应被拒", "POST", f"/lessons/{lesson['id']}/confirm", {}, token=token, expect=409)

print("=== 6. 报表 ===")
ov = step("经营总览", "GET", "/overview?period=2026-10", token=token)
cards = {c["key"]: c for c in ov["cards"]} if isinstance(ov.get("cards"), list) else {}
print(f"     指标卡 keys = {list(cards.keys())}")
fin = step("收支小计", "GET", "/finance/summary?period=2026-10", token=token)
print(f"     收入(课时消费) = {fin.get('incomeConsumption')}，盈利 = {fin.get('profit')}")
rank = step("教师业绩排行", "GET", "/analytics/teacher-ranking?period=2026-10", token=token)
print(f"     排行 = {[(r['rank'], r['teacherName'], r['performance']) for r in rank]}")
step("沉睡名单", "GET", "/risks/sleeping", token=token)

print()
if failures:
    print("存在失败项：")
    for item in failures:
        print("  -", item)
    sys.exit(1)
print("全部冒烟步骤通过")
