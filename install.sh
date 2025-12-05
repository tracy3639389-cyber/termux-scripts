#!/bin/bash

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}    Tracy Server 一键安装助手 v1.3    ${RESET}"
echo -e "${CYAN}========================================${RESET}"

# 1. 强制更新源和软件
echo -e "${YELLOW}正在更新系统组件...${RESET}"
pkg update -y

# 2. 强制安装 Node.js (不再跳过)
echo -e "${GREEN}正在安装核心引擎 (Node.js)...${RESET}"
pkg install nodejs -y

# 3. 强制安装 wget (如果缺失)
pkg install wget -y

# 4. 下载代码
echo -e "${GREEN}正在下载服务器代码...${RESET}"
rm -f $HOME/server.js # 删除旧的，确保下载新的
wget -O $HOME/server.js https://raw.githubusercontent.com/tracy3639389-cyber/termux-scripts/main/server.js

# 5. 安装依赖 (使用淘宝源加速)
echo -e "${GREEN}正在配置运行环境...${RESET}"
cd $HOME
npm config set registry https://registry.npmmirror.com/
npm install express ws

# 6. 设置 run 快捷键
sed -i '/alias run=/d' $HOME/.bashrc
echo "alias run='node ~/server.js'" >> $HOME/.bashrc

# 7. 设置桌面小组件
mkdir -p $HOME/.shortcuts
echo "node ~/server.js" > $HOME/.shortcuts/TracyServer
chmod +x $HOME/.shortcuts/TracyServer

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}      安装成功！      ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo -e "请务必执行以下操作："
echo -e "1. ${YELLOW}重启 Termux${RESET} (彻底关闭后台再打开)"
echo -e "2. 输入 ${YELLOW}run${RESET} 即可启动"
echo ""
