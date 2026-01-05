#!/bin/bash

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m' # 新增红色用于报错
RESET='\033[0m'

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}    Tracy Server 一键安装助手 v1.6    ${RESET}"
echo -e "${CYAN}========================================${RESET}"

# 1. 强制更新源和软件
echo -e "${YELLOW}正在更新系统组件...${RESET}"
# 使用 -o Dpkg::Options::="--force-confnew" 自动处理配置文件冲突，避免卡在问答界面
pkg update -y -o Dpkg::Options::="--force-confnew"
pkg upgrade -y -o Dpkg::Options::="--force-confnew"

# 2. 强制安装 Node.js 和 wget
echo -e "${GREEN}正在安装核心引擎 (Node.js & wget)...${RESET}"
pkg install nodejs wget -y

# 3. 下载代码 (增加重试机制和加速镜像)
echo -e "${GREEN}正在下载服务器代码...${RESET}"
rm -f $HOME/server.js 

# ⚠️ 关键修改：使用 ghproxy 加速链接，既无缓存又能直连
# 如果你想用原链接，请确保用户都开了梯子
DOWNLOAD_URL="https://mirror.ghproxy.com/https://raw.githubusercontent.com/tracy3639389-cyber/termux-scripts/main/server.js"

wget -O $HOME/server.js "$DOWNLOAD_URL"

# 4. 下载校验 (防止下载失败还提示成功)
if [ ! -s "$HOME/server.js" ]; then
    echo -e "${RED}❌ 错误：代码下载失败！请检查网络或代理设置。${RESET}"
    echo -e "${YELLOW}尝试方案：请确保可以访问 GitHub，或稍后再试。${RESET}"
    exit 1
fi

# 5. 安装依赖 (清理旧依赖 + 淘宝源)
echo -e "${GREEN}正在配置运行环境...${RESET}"
cd $HOME
# 清理旧的 node_modules 确保环境纯净
rm -rf node_modules package-lock.json
npm config set registry https://registry.npmmirror.com/
npm install express ws

# 6. 设置 run 快捷键
sed -i '/alias run=/d' $HOME/.bashrc 2>/dev/null
sed -i '/alias run=/d' $HOME/.zshrc 2>/dev/null
echo "alias run='node ~/server.js'" >> $HOME/.bashrc
if [ -f "$HOME/.zshrc" ]; then
    echo "alias run='node ~/server.js'" >> $HOME/.zshrc
fi

# 7. 设置桌面小组件 (规范化)
mkdir -p $HOME/.shortcuts
# 增加 Shebang 头，让 Widget 运行更稳定
echo "#!/data/data/com.termux/files/usr/bin/bash" > $HOME/.shortcuts/TracyServer
echo "node ~/server.js" >> $HOME/.shortcuts/TracyServer
chmod +x $HOME/.shortcuts/TracyServer

clear
echo -e "${CYAN}========================================${RESET}"
echo -e "${GREEN}      ✨ 安装成功！(Build 1.6) ✨      ${RESET}"
echo -e "${CYAN}========================================${RESET}"
echo -e "🚀 操作指南："
echo -e "1. 输入 ${YELLOW}run${RESET} 启动服务"
echo -e "2. 如果之前已启动，请 ${YELLOW}重启 Termux${RESET} 生效"
echo -e "3. 遇到问题？请确保代理软件 (Clash) 已开启"
echo ""
