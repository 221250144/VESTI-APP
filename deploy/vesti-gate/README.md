# Vesti Gateway (vesti-gate)

藏 key 的轻量流式代理:**上游 API key 只落在官方服务器**,客户端(APP/插件)只携带
公开的 service token。SSE 逐 chunk 透传、不缓冲完整响应,所以 1.6G 小服务器也能
服务大量并发用户 —— 吞吐瓶颈只在上游模型生成速度,网关自身几乎零开销。

## 路由

| 路由 | 上游 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | deepseek / moonshot | 按 model 前缀路由:`moonshot*`/`kimi*` → Kimi,其余 → DeepSeek。**无白名单**,model id 原样透传 |
| `POST /api/chat` | 同上 | 旧客户端兼容(强制非流式) |
| `POST /v1/images/generations` `/v1/images/edits` | 147ai | 绘图接口,multipart 原样透传 |
| `GET /v1/models` | — | 模型清单(客户端模型选择器用) |
| `POST /api/embeddings` | — | 暂 502,等聚合站 key;客户端会自动回落旧网关 |
| `POST /v1/collect/sessions` | — | **数据贡献收集**(RL 训练数据):接收用户显式同意后的 agent/CLI 会话批次(`{contributorId, sessions[]}`,每批 ≤50),落盘 `/var/lib/vesti-gate/collect/sessions-YYYY-MM-DD.jsonl`。浏览器端数据客户端从不发送;含个人信息的会话客户端先过滤,服务端再用同一组 PII 模式复查丢弃(响应 `filtered` 计数) |
| `GET /crowdfund/` | — | **众筹公开页**(无需鉴权):自包含 HTML,讲众筹缘由/资金用途/三档权益/兑换指引;收款码为占位 SVG,正式上线前换真码 |
| `POST /v1/crowdfund/redeem` | — | **众筹码兑换**(需鉴权头):body `{code}`,格式 `VESTI-XXXX-XXXX-XXXX`(Crockford 大写无歧义)。有效码清单读 `/opt/vesti-gate/crowdfund-codes.json`(`{codes:{码:档位}}`,**文件不存在则所有码 invalid_code**,上线前再投放真码);档位→积分映射在 server.mjs 的 `CROWDFUND_TIERS`。限流 20 次/小时/IP;兑换记录落盘 `/var/lib/vesti-gate/crowdfund/redeem-YYYY-MM-DD.jsonl`,兑换即作废(重启后仍识别重复兑换) |
| `GET /health` | — | 探活 + 各 provider key 配置状态 |

## 部署(8.153.195.205)

```bash
# 1. 代码就位
mkdir -p /opt/vesti-gate /var/log/vesti-gate
# server.mjs / vesti-gate.service / nginx-vesti-gate.conf 上传后:
cp vesti-gate.service /etc/systemd/system/
cp nginx-vesti-gate.conf /etc/nginx/sites-available/vesti-gate
ln -s /etc/nginx/sites-available/vesti-gate /etc/nginx/sites-enabled/vesti-gate

# 2. 写 key(仅服务器持有)
cat > /opt/vesti-gate/.env <<'EOF'
VESTI_CLIENT_TOKEN=<客户端 service token>
DEEPSEEK_API_KEY=<deepseek key>
MOONSHOT_API_KEY=<kimi key>
IMAGE147_API_KEY=<147ai key>
EOF
chmod 600 /opt/vesti-gate/.env

# 3. 启动 + HTTPS(certbot 自动签 sslip 证书)
systemctl enable --now vesti-gate
nginx -t && systemctl reload nginx
certbot --nginx -d 8.153.195.205.sslip.io --redirect -m <email> --agree-tos -n
```

## 运维

- 日志:`journalctl -u vesti-gate -f`;用量计量:`/var/log/vesti-gate/usage.jsonl`
  (每请求一行:ip/route/model/provider/status/usage tokens —— 会员积分体系的数据源)
- 限流:chat 600 次/10 分钟/IP,绘图 60 次/10 分钟/IP,众筹兑换 20 次/小时/IP(进程内滑窗)
- 众筹:真码投放到 `/opt/vesti-gate/crowdfund-codes.json`(格式 `{ "codes": { "VESTI-XXXX-XXXX-XXXX": "warm|fellow|cocreate" } }`),
  保存即生效(每次兑换重读);兑换记录 `/var/lib/vesti-gate/crowdfund/redeem-*.jsonl`;
  路径可用 `.env` 的 `CROWDFUND_CODES_PATH` / `CROWDFUND_DIR` 覆盖
- 升级:替换 `/opt/vesti-gate/server.mjs` 后 `systemctl restart vesti-gate`
