#!/bin/bash

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}    Tracy Server 一键安装助手 v1.2    ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo -e "${YELLOW}正在初始化环境...${RESET}"
echo ""

# 【修改点】删除了 termux-change-repo，使用默认源更稳
# 尝试修复源并更新
pkg update -y

# 安装 Node.js 和 wget
if ! command -v node &> /dev/null; then
    echo -e "${GREEN}正在安装 Node.js...${RESET}"
    pkg install nodejs -y
fi

if ! command -v wget &> /dev/null; then
    echo -e "${GREEN}正在安装下载工具...${RESET}"
    pkg install wget -y
fi

# 下载代码
echo -e "${GREEN}正在下载 Tracy Server...${RESET}"
wget -O $HOME/server.js https://raw.githubusercontent.com/tracy3639389-cyber/termux-scripts/main/server.js

# 安装依赖
echo -e "${GREEN}正在安装依赖库...${RESET}"
cd $HOME
# 使用淘宝镜像加速 npm 安装
npm config set registry https://registry.npmmirror.com/
npm install express ws

# 设置快捷指令
sed -i '/alias run=/d' $HOME/.bashrc
echo "alias run='node ~/server.js'" >> $HOME/.bashrc
source $HOME/.bashrc

# 设置桌面小组件
mkdir -p $HOME/.shortcuts
echo "node ~/server.js" > $HOME/.shortcuts/TracyServer
chmod +x $HOME/.shortcuts/TracyServer

clear
echo -e "${GREEN}安装完成！${RESET}"
echo -e "输入 ${YELLOW}run${RESET} 启动服务。"
echo ""
sleep 2
node ~/server.js
