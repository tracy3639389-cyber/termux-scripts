#!/bin/bash

# 定义颜色，让界面更好看
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}    Tracy Server 一键安装助手 v1.1    ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo -e "${YELLOW}正在初始化环境，请稍候...${RESET}"
echo ""

# 1. 基础环境更新
termux-change-repo
pkg update -y && pkg upgrade -y

# 2. 安装 Node.js 和 wget
if ! command -v node &> /dev/null; then
    echo -e "${GREEN}正在安装 Node.js环境...${RESET}"
    pkg install nodejs -y
fi

if ! command -v wget &> /dev/null; then
    echo -e "${GREEN}正在安装下载工具...${RESET}"
    pkg install wget -y
fi

# 3. 下载你的服务器代码
echo -e "${GREEN}正在下载 Tracy Server 核心代码...${RESET}"
# 强制覆盖下载，确保是最新版
wget -O $HOME/server.js https://cdn.jsdelivr.net/gh/tracy3639389-cyber/termux-scripts@main/server.js

# 【重要修复】 4. 安装依赖库 (express 和 ws)
echo -e "${GREEN}正在安装必要的依赖库...${RESET}"
cd $HOME
npm config set registry https://registry.npmmirror.com/
npm install express ws

# 5. 创建快捷启动命令
# 先清理旧的别名防止重复
sed -i '/alias run=/d' $HOME/.bashrc
echo "alias run='node ~/server.js'" >> $HOME/.bashrc
source $HOME/.bashrc

# 6. 配置桌面小组件 (Termux:Widget)
if [ -d "$HOME/.shortcuts" ]; then
    echo "node ~/server.js" > $HOME/.shortcuts/TracyServer
    chmod +x $HOME/.shortcuts/TracyServer
else
    mkdir -p $HOME/.shortcuts
    echo "node ~/server.js" > $HOME/.shortcuts/TracyServer
    chmod +x $HOME/.shortcuts/TracyServer
fi

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}      恭喜！安装已全部完成！      ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo ""
echo -e "启动方法："
echo -e "在屏幕上输入 ${YELLOW}run${RESET} 然后按回车即可启动！"
echo ""
echo -e "${YELLOW}3秒后自动尝试首次启动...${RESET}"
sleep 3
node ~/server.js
