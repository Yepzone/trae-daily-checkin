#!/usr/bin/env node
/**
 * TRAE CN 每日自动签到
 *
 * 流程：读取本地登录态 -> 解密 accessToken -> 查签到状态 -> 未签到则领取 -> 写日志
 * 登录态只在本进程内存中使用，不打印、不落盘。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const API_HOST = "api.trae.cn";
const AUTH_KEY = "iCubeAuthInfo://icube.cloudide";

// Trae 客户端内置常量
const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const HEADER_AES = Buffer.from([116, 99, 5, 16, 0, 0]);

const LOG_FILE = path.join(__dirname, "checkin.log");

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + os.EOL, "utf8");
  } catch {}
}

/** 解密 storage.json 中的登录态字段 */
function decryptValue(encoded) {
  const buf = Buffer.from(encoded, "base64");
  if (buf.length <= 102) throw new Error("密文长度异常");
  if (!buf.subarray(0, 6).equals(HEADER_AES)) throw new Error("不支持的加密格式");

  const random = buf.subarray(6, 38);
  const cipherText = buf.subarray(38);

  const salt = Buffer.from(SALT_A.map((v, i) => v ^ SALT_B[i]));
  const first = crypto.createHash("sha512").update(random).digest();
  const derived = crypto.createHash("sha512").update(Buffer.concat([first, salt])).digest();

  const decipher = crypto.createDecipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);

  const plain = decrypted.subarray(64);
  if (!decrypted.subarray(0, 64).equals(crypto.createHash("sha512").update(plain).digest())) {
    throw new Error("完整性校验失败");
  }
  return plain.toString("utf8");
}

/** 从本地客户端读取登录态 */
function loadAuth() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const roots = ["Trae CN", "TRAE SOLO CN"].map((n) => path.join(appdata, n));

  let lastErr = "未找到 storage.json";
  for (const root of roots) {
    const storagePath = path.join(root, "User", "globalStorage", "storage.json");
    if (!fs.existsSync(storagePath)) continue;
    try {
      const storage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
      const raw = storage[AUTH_KEY];
      if (!raw) {
        lastErr = `${path.basename(root)} 未登录`;
        continue;
      }
      const auth = JSON.parse(raw.startsWith("{") ? raw : decryptValue(raw));
      const token = auth.token || auth.accessToken;
      if (!token) {
        lastErr = `${path.basename(root)} 登录态中无 token`;
        continue;
      }
      const dcKey = Object.keys(storage).find((k) => k.startsWith("iCubeAuthInfo://icube-dc:"));
      const deviceId = dcKey ? dcKey.slice("iCubeAuthInfo://icube-dc:".length) : storage["telemetry.devDeviceId"] || "";
      return { token, deviceId, app: path.basename(root) };
    } catch (e) {
      lastErr = `${path.basename(root)}: ${e.message}`;
    }
  }
  throw new Error(lastErr);
}

/** 调用签到接口（失败重试一次） */
function callApi(apiPath, token, deviceId, retry = 1) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: apiPath,
        method: "POST",
        timeout: 40000,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Cloud-IDE-JWT ${token}`,
          Origin: "https://www.trae.cn",
          Referer: "https://www.trae.cn/",
          ...(deviceId ? { "x-device-id": deviceId } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", (e) => {
      if (retry > 0) setTimeout(() => callApi(apiPath, token, deviceId, retry - 1).then(resolve, reject), 3000);
      else reject(e);
    });
    req.end("{}");
  });
}

async function main() {
  let auth;
  try {
    auth = loadAuth();
  } catch (e) {
    log(`读取登录态失败：${e.message}。请先打开 TRAE 客户端登录。`);
    process.exit(1);
  }

  const { token, deviceId, app } = auth;
  const api = (p) => callApi(`/trae/api/v2/ug/checkin_credits/${p}`, token, deviceId);

  let status;
  try {
    status = await api("status");
  } catch (e) {
    log(`查询签到状态失败：${e.message}`);
    process.exit(1);
  }
  if (status.status === 401 || status.status === 403) {
    log(`登录态已失效（HTTP ${status.status}），请打开 TRAE 客户端重新登录。`);
    process.exit(1);
  }
  if (status.status !== 200) {
    log(`查询签到状态失败（HTTP ${status.status}）：${status.body.slice(0, 200)}`);
    process.exit(1);
  }

  let data = {};
  try {
    data = JSON.parse(status.body);
  } catch {}
  if (data.code === 1001) {
    log("登录态校验失败（code=1001），请打开 TRAE 客户端重新登录。");
    process.exit(1);
  }
  if (data.checked_in) {
    log(`今日已签到，今日可得积分 ${data.credits ?? "-"}（客户端：${app}）。`);
    return;
  }
  if (data.enable === false) {
    log("签到活动当前未开启，跳过。");
    return;
  }

  let claim;
  try {
    claim = await api("claim");
  } catch (e) {
    log(`签到请求失败：${e.message}`);
    process.exit(1);
  }

  let result = {};
  try {
    result = JSON.parse(claim.body);
  } catch {}
  if (claim.status === 200 && (result.code === 0 || result.code === undefined)) {
    const after = await api("status").catch(() => null);
    let credits = "-";
    try {
      credits = JSON.parse(after.body).credits ?? "-";
    } catch {}
    log(`签到成功，获得积分 ${credits}（客户端：${app}）。`);
  } else {
    log(`签到未成功（HTTP ${claim.status}, code=${result.code}, msg=${result.message || ""}）。`);
    process.exit(1);
  }
}

main();
