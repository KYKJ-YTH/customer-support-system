#!/bin/bash
# deploy.sh - 在 Linux 服务器上首次部署客服知识库系统
# 适用系统: Ubuntu 22.04 / Debian 12
# 用法: bash deploy.sh

set -euo pipefail

# ── 1. 读取配置 ──────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  echo "[错误] 未找到 .env 文件，请先复制 .env.example 并填写配置"
  exit 1
fi
source .env

echo "== 客服知识库部署开始 =="

# ── 2. 检查 Docker ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo ">> 安装 Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version &>/dev/null; then
  echo "[错误] Docker Compose v2 未安装，请升级 Docker 到 24.0+ 版本"
  exit 1
fi

# ── 3. 安装 Node.js 24（如未安装）────────────────────────────────────────────
if ! node --version 2>/dev/null | grep -q '^v2[4-9]'; then
  echo ">> 安装 Node.js 24..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

# ── 4. 申请 HTTPS 证书（Let's Encrypt）──────────────────────────────────────
if [ ! -f "nginx/certs/fullchain.pem" ]; then
  if [ -z "${DOMAIN:-}" ]; then
    echo "[警告] 未配置 DOMAIN，跳过 HTTPS 证书申请，将使用 HTTP"
  else
    echo ">> 申请 Let's Encrypt 证书（域名: $DOMAIN）..."
    if ! command -v certbot &>/dev/null; then
      apt-get install -y certbot
    fi
    # 临时监听 80 端口完成 ACME 验证
    certbot certonly --standalone -d "$DOMAIN" \
      --non-interactive --agree-tos -m "${CERT_EMAIL:-admin@${DOMAIN}}"
    mkdir -p nginx/certs
    ln -sf "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" nginx/certs/fullchain.pem
    ln -sf "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   nginx/certs/privkey.pem
    # 将域名写入 nginx 配置
    sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" nginx/conf.d/maxkb.conf
    echo ">> 证书申请成功"
  fi
else
  echo ">> 证书文件已存在，跳过申请"
fi

# ── 5. 安装 Node 依赖 ─────────────────────────────────────────────────────────
echo ">> npm ci..."
npm ci

# ── 6. 首次启动不带覆盖层的 MaxKB（生成集成文件需要它在线）──────────────────
echo ">> 启动 MaxKB 基础实例..."
docker compose -f compose.yaml up -d

echo ">> 等待 MaxKB 初始化（约 30 秒）..."
sleep 30

# ── 7. 生成前端导航覆盖层 ─────────────────────────────────────────────────────
echo ">> 生成录入页面集成..."
npm run integrate:maxkb

# ── 8. 以生产配置重新启动（含 nginx）─────────────────────────────────────────
echo ">> 以生产配置启动（MaxKB + nginx）..."
docker compose -f compose.yaml -f compose.prod.yaml up -d

# ── 9. 初始化演示数据 ─────────────────────────────────────────────────────────
echo ">> 初始化演示知识库..."
sleep 10
npm run seed || echo "[警告] seed 未完全成功，可手动运行 npm run seed"

# ── 10. 验证 ──────────────────────────────────────────────────────────────────
echo ">> 验证部署..."
npm run verify || echo "[警告] 部分验证未通过，请查看上方输出"

echo ""
echo "== 部署完成 =="
if [ -n "${DOMAIN:-}" ]; then
  echo "   管理后台: https://${DOMAIN}/admin/login"
  echo "   客服录入: https://${DOMAIN}/admin/customer-knowledge-intake"
else
  echo "   管理后台: http://$(hostname -I | awk '{print $1}'):8088/admin/login"
  echo "   (生产环境请配置域名并启用 HTTPS)"
fi
echo "   初始密码: 见 .local/login.json"
echo ""
echo "后续运维:"
echo "  启动: docker compose -f compose.yaml -f compose.prod.yaml up -d"
echo "  停止: docker compose stop"
echo "  状态: docker compose ps"
echo "  证书续期: certbot renew（建议配置 cron 每月执行）"
