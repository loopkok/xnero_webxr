# 环境依赖清单

## 1. 操作系统

- Linux（Ubuntu 20.04+ / 22.04 已验证）
- macOS / Windows 理论上可用（未测试）

## 2. Python 环境

| 依赖 | 版本 | 用途 |
|------|------|------|
| Python | **3.10+** | 运行时 |
| Conda | 推荐 | 环境隔离 |

建议创建独立环境：

```bash
conda create -n xnero_webxr python=3.10
conda activate xnero_webxr
```

## 3. Pip 包

| 包 | 版本 | 用途 |
|---|------|------|
| `numpy` | 2.2+ | 数组计算（ControlGoal 的 target_position） |
| `torch` | 2.12+ | 张量计算 |
| `scipy` | 1.15+ | 四元数旋转计算（`Rotation.from_quat`） |
| `websockets` | 16.1+ | WebSocket 服务器 |
| `pyyaml` | 6.0+ | 解析 `config.yaml` |
| `pynput` | 1.8+ | 键盘监听（桌面端键盘控制机械臂） |

一键安装：

```bash
pip install -r requirements.txt
```

## 4. 系统工具

| 工具 | 版本 | 用途 |
|------|------|------|
| `openssl` | 3.0+ | 自动生成 SSL 自签名证书（首次运行自动调用） |

```bash
# Ubuntu/Debian
sudo apt install openssl
```

## 5. 硬件

| 设备 | 说明 |
|------|------|
| Meta Quest 3 / Quest Pro | VR 头显，WebXR 浏览器 |
| Wi-Fi 路由器 | 头显与 PC 需在同一局域网 |
| USB-C 数据线 | 可选，`adb reverse` 调试模式用 |

## 6. Quest 头显配置

| 设置 | 路径 |
|------|------|
| 手部追踪 | 系统设置 → 运动追踪 → 开启**手部和身体追踪** |
| 浏览器 | Meta Quest Browser |
| 开发者模式 | Quest 手机 App 中开启（ADB 调试用） |

## 7. 可选：ADB 工具（USB 调试）

```bash
# Ubuntu
sudo apt install adb

# macOS
brew install android-platform-tools
```

端口转发（绕过 HTTPS 证书问题）：

```bash
adb reverse tcp:8443 tcp:8443
adb reverse tcp:8442 tcp:8442
# Quest 浏览器访问 http://localhost:8443 即可
```

## 8. 网络端口

| 端口 | 协议 | 用途 |
|------|------|------|
| 8443 | HTTPS | 静态文件服务（`web-ui/`） |
| 8442 | WSS | VR 数据 WebSocket |

确保防火墙放行这两个端口：

```bash
# Ubuntu ufw
sudo ufw allow 8443/tcp
sudo ufw allow 8442/tcp
```
