# Dashboard API

REST API สำหรับ WB Dashboard — Node.js/TypeScript port ของ Python `api_server.py`  
ให้ข้อมูล Wire Bond shift utilization จาก SQL Server ผ่าน HTTP endpoints

## Tech Stack

- **Runtime:** Node.js 22+
- **Framework:** [Fastify](https://fastify.dev/) v4
- **Database:** MSSQL (via `mssql` + Tedious driver)
- **Language:** TypeScript 5 (transpiled with `tsx` / built with `tsup`)

## Setup

```bash
# 1. ติดตั้ง dependencies
npm install

# 2. สร้าง .env จาก template
cp .env.example .env
# แก้ไข DB_PASSWORD และค่าอื่น ๆ ใน .env

# 3. รัน dev server (hot-reload)
npm run dev

# 4. หรือ build แล้วรัน production
npm run build
npm start
```

> **หมายเหตุ:** password ที่มีอักขระพิเศษ เช่น `#` ต้องใส่ quotes ใน `.env`
> ```
> DB_PASSWORD="P@ssw0rd#123"
> ```

## Environment Variables

| ตัวแปร | ค่าตัวอย่าง | คำอธิบาย |
|---|---|---|
| `DB_SERVER` | `mth-cl-mthsql` | SQL Server hostname |
| `DB_PORT` | `1433` | SQL Server port |
| `DB_NAME` | `MTHAI_ppm_db1` | Database name |
| `DB_USER` | `MTHAI_ppm` | SQL login user |
| `DB_PASSWORD` | *(secret)* | SQL login password |
| `API_PORT` | `8002` | Port ที่ API จะ listen |
| `API_HOST` | `0.0.0.0` | Host binding |
| `API_KEY` | `mch_dev_12345` | API key สำหรับ auth header |
| `VIEW_NAME` | `vw_job_nokey` | View ชื่อ job events |
| `MACHINE_TABLE` | `dbo.machine` | Table ข้อมูลเครื่อง |

## Endpoints

### `GET /api/v1/health`

ตรวจสอบสถานะ server และ database — ไม่ต้องใช้ API key

**Response:**
```json
{ "status": "ok", "db": "ok", "version": "1.0.0" }
```

---

### `GET /api/v1/wb/report`

ดึงข้อมูล WB shift utilization รายเครื่อง

**Headers:**
```
x-api-key: <API_KEY>
```

**Query Parameters:**

| Parameter | ค่าที่รับได้ | Default | คำอธิบาย |
|---|---|---|---|
| `date` | `YYYY-MM-DD` | *required* | วันที่ของ shift |
| `shift` | `Day` / `Night` | `Night` | กะการทำงาน (Day = 07:00-19:00, Night = 19:00-07:00) |
| `packages` | `__ALL__` / `__QFN__` / ชื่อ package | `__ALL__` | กรอง package (คั่นด้วย `,` ได้หลาย package) |

**ตัวอย่าง:**
```bash
# Night shift ทุก package
curl "http://localhost:8002/api/v1/wb/report?date=2026-06-04&shift=Night" \
  -H "x-api-key: mch_dev_12345"

# Day shift เฉพาะ QFN
curl "http://localhost:8002/api/v1/wb/report?date=2026-06-04&shift=Day&packages=__QFN__" \
  -H "x-api-key: mch_dev_12345"
```

**Response:**
```json
{
  "status": "ok",
  "data": {
    "shift": "Night",
    "time_range": "19:00 → 07:00",
    "pkg_label": "All Packages",
    "kpi": {
      "total": 944,
      "n_down": 149,
      "n_setup": 360,
      "n_full": 425,
      "n_low": 83,
      "avg_util": 95.1,
      "down_pct": 0.8,
      "wait_pct": 5.5,
      "setup_conv_pct": 0.5,
      "sbo_pct": 1.7,
      "n_tech": 146
    },
    "machines": [
      {
        "machine_id": "W/B # 435L",
        "package": "36L SQFN 6X6(UDX)",
        "util_pct": 0,
        "wait_down_min": 517,
        "down_min": 402,
        "wait_setup_min": 10,
        "setup_min": 0,
        "setup_conv_min": 0,
        "sbo_min": 0,
        "total_loss_min": 929,
        "events": [
          {
            "job_type": "M/C DOWN",
            "t_start": "20:02",
            "t_end": "20:18",
            "des_job": "Tail Too Short",
            "dur_min": 16,
            "is_open": false
          }
        ]
      }
    ]
  }
}
```

**KPI Fields:**

| Field | คำอธิบาย |
|---|---|
| `total` | จำนวนเครื่อง key machine ทั้งหมด |
| `n_down` | เครื่องที่มี M/C DOWN ในกะนั้น |
| `n_setup` | เครื่องที่มี Setup/Convert (ไม่มี Down) |
| `n_full` | เครื่องที่ไม่มี loss เลย |
| `n_low` | เครื่องที่ util < 85% |
| `avg_util` | ค่าเฉลี่ย utilization ทุกเครื่อง (%) |
| `down_pct` | % เวลา repair จาก total fleet time |
| `wait_pct` | % เวลา wait (ก่อน tech มารับ) |
| `setup_conv_pct` | % เวลา Setup/Convert/Clean |
| `sbo_pct` | % เวลา Setup By Operator |
| `n_tech` | จำนวน technician ที่ทำงานในกะนั้น |

**Error Responses:**

| HTTP | เหตุ |
|---|---|
| `400` | ไม่มี `date` หรือ format ผิด |
| `401` | ไม่มี / ผิด `x-api-key` header |
| `503` | DB ต่อไม่ได้ (ดูที่ `/health`) |

## Project Structure

```
dashboard-api/
├── src/
│   ├── index.ts          # Entry point + health endpoint
│   ├── config.ts         # Env var validation
│   ├── db.ts             # MSSQL connection pool
│   └── routes/
│       └── wb.ts         # WB report logic
├── .env.example
├── package.json
└── tsconfig.json
```

## Scripts

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | รัน dev server พร้อม hot-reload (`tsx watch`) |
| `npm run build` | Build เป็น ESM ใน `dist/` |
| `npm start` | รัน production build |
