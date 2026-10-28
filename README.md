# TRAE CN 每日自动签到

复用 TRAE 客户端本地登录态，每天自动领取签到积分。不需要账号密码，不需要模拟点击界面。

## 原理

1. 从客户端 `storage.json` 读取 `iCubeAuthInfo://icube.cloudide` 字段
2. 按客户端同源逻辑解密（SHA-512 派生 + AES-128-CBC）拿到 accessToken
3. 调用 `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` 查询状态
4. 未签到则调用 `.../claim` 领取，结果写入 `checkin.log`

token 只在进程内存中使用，不打印、不落盘。

## 环境要求

- Windows
- Node.js（无需任何第三方依赖）
- 已登录的 TRAE 客户端

## 手动运行

```bat
node trae-checkin.js
```

或双击 `run.cmd`。

脚本是幂等的：当天已签到会直接跳过，重复运行不会重复领取。

## 配置每天定时

以管理员身份打开 PowerShell：

```powershell
schtasks /Create /TN "TRAE_DailyCheckin" ^
  /TR "C:\path\to\run.cmd" ^
  /SC DAILY /ST 10:00 /F
```

查看状态与下次运行时间：

```powershell
schtasks /Query /TN "TRAE_DailyCheckin" /FO LIST /V
```

删除任务：

```powershell
schtasks /Delete /TN "TRAE_DailyCheckin" /F
```

## 输出示例

```
[2026/10/27 10:00:03] 签到成功，获得积分 100（客户端：Trae CN）。
[2026/10/28 10:00:02] 今日已签到，今日可得积分 100（客户端：Trae CN）。
```

## 注意事项

- 定时任务只在开机状态执行，关机时不会补跑
- accessToken 约 7 天过期，由客户端自动续期；长时间不打开客户端会导致脚本报"登录态已失效"，登录一次即可恢复
- 签到接口为客户端私有接口，服务端变更可能导致脚本失效
