#!/bin/bash

# 定义颜色
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

clear
echo -e "${CYAN}=============================================${NC}"
echo -e "${CYAN}       Tracy Server Mac版 启动脚本          ${NC}"
echo -e "${CYAN}=============================================${NC}"

# 1. 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo -e "${RED}[错误] 未检测到 Node.js！${NC}"
    echo -e "请先去官网下载安装: https://nodejs.org/"
    exit 1
fi

# 2. 创建工作目录 (在桌面创建一个文件夹，方便他找)
WORK_DIR="$HOME/Desktop/TracyServer"
if [ ! -d "$WORK_DIR" ]; then
    mkdir -p "$WORK_DIR"
fi
cd "$WORK_DIR"

echo -e "${GREEN}📂 工作目录: 桌面/TracyServer${NC}"

# 3. 强制下载最新代码 (跟 Termux 一样，跳过缓存)
echo -e "${GREEN}⬇️  正在拉取最新服务器代码...${NC}"
curl -sL https://raw.githubusercontent.com/tracy3639389-cyber/termux-scripts/main/server.js > server.js

# 4. 自动安装依赖
if [ ! -d "node_modules" ]; then
    echo -e "${GREEN}📦 正在初始化依赖 (仅首次需要)...${NC}"
    npm init -y > /dev/null 2>&1
    npm install express ws --loglevel=error
fi

# 5. 启动
echo -e "${CYAN}=============================================${NC}"
echo -e "${GREEN}✅ 启动成功！请保持此窗口不要关闭${NC}"
echo -e "IP地址: 127.0.0.1  |  HTTP端口: 8889"
echo -e "${CYAN}=============================================${NC}"

node server.js
