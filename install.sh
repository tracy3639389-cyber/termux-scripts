#!/bin/bash

# 定义颜色
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}    Tracy Server 一键安装助手 v1.0    ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo -e "${YELLOW}正在初始化环境，这可能需要几分钟...${RESET}"
echo ""

# 1. 换源并更新 (为了速度)
termux-change-repo
pkg update -y && pkg upgrade -y

# 2. 安装 Node.js 和 wget
if ! command -v node &> /dev/null; then
    echo -e "${GREEN}正在安装 Node.js...${RESET}"
    pkg install nodejs -y
fi

if ! command -v wget &> /dev/null; then
    echo -e "${GREEN}正在安装基础工具...${RESET}"
    pkg install wget -y
fi

# 3. 下载你的服务器代码
echo -e "${GREEN}正在下载 Tracy Server...${RESET}"
# 注意：这里使用的是你的 GitHub Raw 链接
wget -O $HOME/server.js https://raw.githubusercontent.com/tracy3639389-cyber/termux-scripts/main/server.js

# 4. 创建快捷启动命令
# 以后只要输入 'run' 就可以启动
echo "alias run='node ~/server.js'" >> $HOME/.bashrc
source $HOME/.bashrc

# 5. 如果安装了 Termux:Widget，创建桌面快捷方式脚本
mkdir -p $HOME/.shortcuts
echo "node ~/server.js" > $HOME/.shortcuts/TracyServer
chmod +x $HOME/.shortcuts/TracyServer

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}      恭喜！安装已全部完成！      ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo ""
echo -e "启动方法："
echo -e "在屏幕上输入 ${YELLOW}run${RESET} 然后按回车即可启动！"
echo ""
echo -e "如果手机装了 Termux:Widget，也可以在桌面添加小组件启动。"
echo ""
# 自动尝试启动一次
echo -e "${YELLOW}3秒后自动尝试首次启动...${RESET}"
sleep 3
node ~/server.js
