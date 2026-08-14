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
- 限流:chat 600 次/10 分钟/IP,绘图 60 次/10 分钟/IP(进程内滑窗)
- 升级:替换 `/opt/vesti-gate/server.mjs` 后 `systemctl restart vesti-gate`
