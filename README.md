# XNeroWebVR — VR Teleoperation System

XNeroWebVR 是一个基于 WebXR 的 VR 遥操作（teleoperation）系统，用于通过 VR 头显实时控制双机械臂。支持 **手柄 (Controller)** 和 **手部追踪 (Hand Tracking)** 两种输入模式，输出 MediaPipe 兼容的 21 点手部 landmarks 数据。

---

## 项目结构

```
XNeroWebVR/
├── vr_monitor.py              # 应用入口（可拷贝到任意目录独立使用）
├── config.yaml                # 配置文件
├── cert.pem / key.pem         # SSL 自签名证书（WebXR 需要 HTTPS 或 localhost）
├── requirements.txt           # Python 依赖
├── web-ui/                    # VR 头显浏览器前端
│   ├── index.html             # A-Frame WebXR 场景（手柄 + 手部 3D 可视化实体）
│   ├── vr_app.js              # 控制器 + 手部数据采集、WebSocket 发送、
│   │                          #   双手腕标记 + 21 关节微型坐标轴实时渲染
│   ├── interface.js           # 桌面端 UI（键盘控制、设置面板）
│   ├── styles.css             # 样式
│   └── media/                 # 说明图片
└── xnero_webvr/                     # 核心库
    ├── config.py              # XNeroWebVRConfig 配置类
    ├── utils.py               # SSL 证书生成等工具
    └── inputs/
        ├── base.py            # ControlGoal / HandJoint / HandData 数据结构
        └── vr_ws_server.py    # WebSocket 服务器，VR 数据解析
```



## 架构与数据流

```
┌─────────────────────────────────────────────────────────┐
│  VR 头显 (Meta Quest 3 / Quest Pro / Pico 4)            │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 浏览器 → https://<主机IP>:8443                    │   │
│  │   ├─ A-Frame + Three.js + WebXR API              │   │
│  │   ├─ monkey-patch: 强制注入 hand-tracking 特性    │   │
│  │   ├─ 每帧采集:                                   │   │
│  │   │   ├─ 左/右手柄: position, quaternion,        │   │
│  │   │   │   trigger, thumbstick, buttons           │   │
│  │   │   ├─ 头显: position, rotation                │   │
│  │   │   └─ 左/右手 (hand mode): 25 关节 →          │   │
│  │   │       21点 MediaPipe landmarks               │   │
│  │   └─ vr_app.js: controller-updater tick()        │   │
│  └────────────────────┬─────────────────────────────┘   │
└───────────────────────┼─────────────────────────────────┘
                        │
          WSS (wss://host:8442)  JSON 加密传输
          {timestamp, leftController, rightController,
           headset, leftHand, rightHand, _handDebug}
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  Python 后端 (vr_monitor.py)                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │  SimpleHTTPSServer (:8443)                       │   │
│  │   └─ 提供 web-ui/ 静态文件 (index.html 等)        │   │
│  │                                                  │   │
│  │  VRWebSocketServer (:8442)                       │   │
│  │   ├─ process_controller_data()                   │   │
│  │   │   ├─ controller 模式 → process_single_ctrl() │   │
│  │   │   └─ hand/both 模式 → process_hand_data()    │   │
│  │   │        └─ 腕关节 → 合成控制器 → ControlGoal  │   │
│  │   ├─ 四元数 → 手腕角度 (roll/pitch)              │   │
│  │   └─ 生成 ControlGoal 对象                       │   │
│  └────────────────────┬─────────────────────────────┘   │
│                       ▼                                  │
│           asyncio.Queue (command_queue)                  │
│                       │                                  │
│          ┌────────────┼────────────┐                     │
│          ▼            ▼            ▼                     │
│    机械臂控制循环   数据录制     get_*_nowait() API       │
│    (关节指令转换)  (模仿学习)   (实时查询)                │
└─────────────────────────────────────────────────────────┘
```

### WebSocket JSON 格式

```javascript
{
    "timestamp": 1700000000000,
    "leftController": {
        "hand": "left",
        "position":  {"x": 0.0, "y": 0.0, "z": 0.0},
        "rotation":  {"x": 0.0, "y": 0.0, "z": 0.0},
        "quaternion":{"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
        "trigger": 0,
        "gripActive": false,
        "thumbstick": {"x": 0, "y": 0},
        "buttons": {"a": false, "b": false, "squeeze": false, ...}
    },
    "rightController": { /* 同上 */ },
    "headset": {
        "position":  {"x": 0.0, "y": 0.0, "z": 0.0},
        "rotation":  {"x": 0.0, "y": 0.0, "z": 0.0},
        "quaternion":{"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    },
    "leftHand": {
        "hand": "left",
        "landmarks": [                     // 21 点 MediaPipe 格式
            {"x": -0.14, "y": -0.24, "z": -0.33},  // 0:  WRIST
            {"x": -0.10, "y": -0.23, "z": -0.37},  // 1:  THUMB_CMC
            // ... 共 21 个
        ],
        "wrist": {                         // 腕关节完整 6DoF
            "position":  {"x": -0.14, "y": -0.24, "z": -0.33},
            "quaternion":{"x": 0.32, "y": -0.13, "z": 0.19, "w": 0.92},
            "radius": 0.005
        }
    },
    "rightHand": { /* 同上 */ }
}
```

### 坐标系

```
WebXR 右手坐标系 (OpenGL / Three.js 标准)：

        +Y (上)
        │
        │   左手(-X)    右手(+X)
        │      🤚         🤚
        │
        └─────── +X (右)
       /
      /
     -Z (前，远离身体)
```

- 单位：**米**（真实世界尺度）
- 原点：VR 会话启动时头显的位置（`local-floor` 参考空间）
- 四元数：`(x, y, z, w)` 顺序

---

## 安装

```bash
cd XNeroWebVR
pip install -r requirements.txt
```

依赖：`numpy`, `scipy`, `websockets`, `pyyaml`

---

## 使用方式

### 前置条件

| 要求 | 说明 |
|------|------|
| Python | 3.10+ |
| VR 头显 | Meta Quest 3 / Quest Pro / Pico 4 |
| 网络 | 头显与 PC 连接**同一局域网 / Wi-Fi** |
| Quest 设置 | 系统设置 → 运动追踪 → 开启**手部和身体追踪** |

### 快速开始

**1. 安装依赖**

```bash
cd XNeroWebVR
pip install -r requirements.txt
```

**2. 配置（可选）**

编辑 `config.yaml`：

```yaml
vr:
  input_mode: hand   # controller（手柄）| hand（手部追踪）| both（同时启用）
```

**3. 启动服务**

```bash
python vr_monitor.py
```

终端输出：
```
[VR_WS] Input mode: 🖐️  Hand Tracking
✅ VR Monitor is now running
📱 Open your VR headset browser and navigate to:
   https://192.168.0.231:8443
```

**4. Quest 头显连接**

| 步骤 | 操作 |
|------|------|
| 打开浏览器 | Meta Quest Browser |
| 输入地址 | `https://<终端显示的IP>:8443` |
| 跳过证书警告 | 点"高级"→"继续前往" |
| 进入 VR | 点右下角 VR 眼镜图标进入沉浸模式 |
| 放下手柄 | 把手柄放桌上，等待 3-5 秒自动切换到手部追踪 |
| 查看可视化 | 金色（左手）/ 青色（右手）坐标轴出现在手腕位置 |

> **USB 调试模式**（避免证书问题）：USB 连接 Quest 后执行 `adb reverse tcp:8443 tcp:8443 && adb reverse tcp:8442 tcp:8442`，浏览器访问 `http://localhost:8443`。

### 配置说明

```yaml
# config.yaml
network:
  https_port: 8443          # HTTPS 静态文件服务端口
  websocket_port: 8442      # WebSocket VR 数据端口
  host_ip: 0.0.0.0          # 监听地址

vr:
  input_mode: hand          # controller | hand | both
```

| 模式 | 手柄 6DoF | 手部 landmarks (21点) | 适用场景 |
|------|----------|---------------------|---------|
| `controller` | ✅ | ❌ | 用手柄控制机械臂 |
| `hand` | ❌ | ✅ | 裸手追踪控制机械臂 |
| `both` | ✅ | ✅ | 手柄优先，同时录制手部数据 |

> **注意**：`input_mode` 控制的是**服务端**如何处理数据。浏览器端始终同时采集手柄和手部数据并发送 3D 可视化。

### 在代码中集成

`vr_monitor.py` 既是独立入口，也是一个可导入的库。在你的项目中使用：

```python
from vr_monitor import VRMonitor
import asyncio, threading

# 启动 VR 监控（后台线程）
monitor = VRMonitor()
threading.Thread(
    target=lambda: asyncio.run(monitor.start_monitoring()),
    daemon=True
).start()

# ---- 读取控制目标（机械臂控制用） ----
left  = monitor.get_left_goal_nowait()    # ControlGoal or None
right = monitor.get_right_goal_nowait()

if left:
    pos = left.target_position   # np.ndarray [x, y, z]
    roll = left.wrist_roll_deg   # float, 腕部翻滚角 (度)
    flex = left.wrist_flex_deg   # float, 腕部俯仰角 (度)
    grip = left.gripper_closed   # bool, 夹爪是否闭合

# ---- 读取手部 21 点 landmarks ----
left_hand  = monitor.get_left_hand_nowait()   # dict or None
right_hand = monitor.get_right_hand_nowait()

if left_hand:
    lm = left_hand["landmarks"]    # 21 个 {x, y, z}
    lm[0]   # WRIST
    lm[4]   # THUMB_TIP
    lm[8]   # INDEX_FINGER_TIP
    lm[12]  # MIDDLE_FINGER_TIP
    lm[16]  # RING_FINGER_TIP
    lm[20]  # PINKY_TIP

    wrist = left_hand["wrist"]         # 腕关节 6DoF
    wrist["position"]                  # {x, y, z}
    wrist["quaternion"]                # {x, y, z, w}
```

### VR 场景中的可视化

进入 VR 模式后，浏览器会实时渲染：

| 元素 | 颜色 | 说明 |
|------|------|------|
| 左手腕标记 | 🟡 金色 | 球体 + RGB 坐标轴 + 位姿文字 |
| 右手腕标记 | 🩵 青色 | 球体 + RGB 坐标轴 + 位姿文字 |
| 左手 21 关节 | 🔴🟢🔵 RGB 微型轴 | 每个关节一组 1.5cm 坐标轴 |
| 右手 21 关节 | 🔴🟢🔵 RGB 微型轴 | 同上 |
| 诊断面板 | ⬜ 白色 | 每 5 秒刷新，显示 hand tracking 状态 |
| 手柄（如有） | 🔴🟢🔵 RGB | 物理手柄位姿 |



## 数据结构参考

### ControlGoal

| 字段 | 类型 | 说明 |
|------|------|------|
| `arm` | `Literal["left","right","headset"]` | 控制目标来源 |
| `mode` | `ControlMode` | POSITION_CONTROL / HAND_CONTROL / IDLE |
| `target_position` | `np.ndarray (3,)` | 目标位置 (机器人坐标系, 米) |
| `wrist_roll_deg` | `float` | 手腕翻滚角 (度) |
| `wrist_flex_deg` | `float` | 手腕俯仰角 (度) |
| `gripper_closed` | `bool` | 夹爪闭合状态 |
| `metadata` | `dict` | 包含 hand_data (21 landmarks) 等额外信息 |

### HandData

| 字段 | 类型 | 说明 |
|------|------|------|
| `hand` | `str` | "left" 或 "right" |
| `joints` | `dict[str, HandJoint]` | 25 个关节 (WebXR 命名) |
| `timestamp` | `float` | 浏览器端时间戳 |

### HandJoint

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `str` | 关节名 (如 "wrist", "index-finger-tip") |
| `position` | `np.ndarray (3,)` | (x, y, z) 米 |
| `orientation` | `np.ndarray (4,)` | (x, y, z, w) 四元数 |
| `radius` | `float` | 关节半径 (米) |

### MediaPipe 21 点映射

| 索引 | 名称 | WebXR 关节名 |
|------|------|-------------|
| 0 | WRIST | wrist |
| 1 | THUMB_CMC | thumb-metacarpal |
| 2 | THUMB_MCP | thumb-phalanx-proximal |
| 3 | THUMB_IP | thumb-phalanx-distal |
| 4 | THUMB_TIP | thumb-tip |
| 5 | INDEX_FINGER_MCP | index-finger-phalanx-proximal |
| 6 | INDEX_FINGER_PIP | index-finger-phalanx-intermediate |
| 7 | INDEX_FINGER_DIP | index-finger-phalanx-distal |
| 8 | INDEX_FINGER_TIP | index-finger-tip |
| 9 | MIDDLE_FINGER_MCP | middle-finger-phalanx-proximal |
| 10 | MIDDLE_FINGER_PIP | middle-finger-phalanx-intermediate |
| 11 | MIDDLE_FINGER_DIP | middle-finger-phalanx-distal |
| 12 | MIDDLE_FINGER_TIP | middle-finger-tip |
| 13 | RING_FINGER_MCP | ring-finger-phalanx-proximal |
| 14 | RING_FINGER_PIP | ring-finger-phalanx-intermediate |
| 15 | RING_FINGER_DIP | ring-finger-phalanx-distal |
| 16 | RING_FINGER_TIP | ring-finger-tip |
| 17 | PINKY_MCP | pinky-finger-phalanx-proximal |
| 18 | PINKY_PIP | pinky-finger-phalanx-intermediate |
| 19 | PINKY_DIP | pinky-finger-phalanx-distal |
| 20 | PINKY_TIP | pinky-finger-tip |

> ⚠️ WebXR 25 关节中多出的 4 个 metacarpal（index/middle/ring/pinky-finger-metacarpal）在转换时被跳过，对应掌骨根部的解剖结构，MediaPipe 没有对应的点。

---

## 常见问题与解决方案

### 1. `XNERO_WEBVR_PATH` 路径错误

```
FileNotFoundError: '/home/xxx/XNeroWebVR'
```

**原因**：`vr_monitor.py` 中的 `XNERO_WEBVR_PATH` 未指向本机实际路径。

**解决**：修改 `vr_monitor.py` 顶部 `XNERO_WEBVR_PATH` 为本机实际路径。

### 2. WebXR 会话无法启动

```
session=False frame=False inputSources=0
```

**原因**：自签名 HTTPS 证书被 Quest 浏览器阻止 WebXR。

**解决**：
```bash
adb reverse tcp:8443 tcp:8443
adb reverse tcp:8442 tcp:8442
# Quest 浏览器访问 http://localhost:8443
```
localhost 不需要 HTTPS 即可使用 WebXR。

### 3. 手部追踪不工作 (`hasHand=False`)

**原因**：
- Quest 系统设置里手部追踪未开启
- 手柄还在手里（Quest 默认用手柄替代手部追踪）
- `<a-scene>` 的 `webxr="optionalFeatures: hand-tracking"` 属性可能导致 A-Frame 解析失败

**解决**：
- Quest 设置 → 运动追踪 → 开启"手部和身体追踪"
- 把手柄放桌上，等 3-5 秒让 Quest 自动切换到裸手追踪
- 已通过 monkey-patch 强制注入 `hand-tracking` 特性，不需要依赖 `<a-scene>` 属性

### 4. `getJointPose()` 返回 null / 提取 `n=25 hit=0 miss=25`

**原因**：Quest 最新浏览器使用 WebXR 新规范 API，废弃了 `XRPose.position` 属性（返回 null），改用 `XRPose.transform.position`。

**解决**：提取代码已兼容两种 API：
```javascript
const p = pose.position || (pose.transform && pose.transform.position);
const o = pose.orientation || (pose.transform && pose.transform.orientation);
```

### 5. Quest `XRHand` 不支持 `entries()`/`keys()`/`for-of`

**原因**：Quest 浏览器的 `XRHand` 实现未遵循 WebXR 规范的可迭代接口。

**解决**：使用硬编码的 25 关节名列表 + `hand.get(name)` 逐个获取。

### 6. `session.inputSources` 只显示控制器，不显示手

**原因**：手部追踪只在**放下手柄后**才激活。Quest 不支持控制器和手部同时追踪。

**解决**：把手柄放桌上，输入源会从 `profiles=['oculus-touch',...]` 变为 `profiles=['oculus-hand',...]`。

### 7. `webxr="optionalFeatures: hand-tracking"` 导致 VR 无法进入

**原因**：A-Frame 1.7.1 在某些浏览器上解析该属性时可能导致会话请求失败。

**解决**：已从 `<a-scene>` 移除该属性，改为通过 monkey-patch `navigator.xr.requestSession` 强制注入 `hand-tracking`。

---

## 技术要点

- **WebXR 坐标系**：右手系 (OpenGL)，+X 右、+Y 上、-Z 前，单位米
- **WebXR vs MediaPipe**：WebXR 25 关节 → 跳过 4 个 metacarpal → 21 点 MediaPipe
- **WebXR vs Unity**：WebXR 是右手系 (OpenGL)、Unity 是左手系 (+Z 前)
- **四元数顺序**：(x, y, z, w) — Three.js / WebXR / scipy 标准
- **参考空间**：`local` (推荐用于手部追踪) 替代默认的 `local-floor`
- **手部可视化**：Quest 3 浏览器中双手腕金色/青色标记 + 21 关节 RGB 微型坐标轴，坐标系统自动从 `local` 转换到场景 `local-floor` 参考空间

---

## TODO

- [ ] **视觉显示优化** — 整体 UI/UX 改进，提升 VR 场景中数据展示的清晰度
- [ ] **关键数据展示优化** — 手腕位姿、关节角度等核心信息更直观地呈现
- [ ] **坐标轴视觉效果优化** — 调整轴的颜色、透明度、粗细，减少视觉干扰
- [ ] **FPS 显示** — VR 场景中实时显示帧率
- [ ] **TCP 有线连接** — 支持通过 USB 线建立 TCP 连接，降低延迟、提高稳定性
- [ ] **APK 打包** — 将 Web 前端打包为 Quest 原生 APK，集成：
  - 数据采集（VR 手柄 + 手部追踪数据录制）
  - Ego 采集（头显前置摄像头画面录制）

---

## 变更记录

### 2026-07-28

- **新增** Quest 3 浏览器端双手 3D 可视化：手腕标记（球体 + RGB 坐标轴 + 位姿文字）+ 21 关节微型 RGB 坐标轴
- **新增** 服务端启动时打印当前输入模式（controller / hand / both）
- **修复** `input_mode: hand` 时手柄摇杆/按钮日志仍打印的问题（添加 `input_mode` 守卫）
- **修复** 浏览器端双手坐标轴不显示的问题（强制 `object3D.visible = true`，手柄实体始终可见）
- **修复** 手部标记"闪一下就消失"的问题 — 根因是 `local` 参考空间（原点=头显）坐标直接用于 `local-floor` 场景（原点=地面），改为通过 `xrFrame.getJointPose(js, sceneRefSpace)` 直接在场景空间获取关节位姿
- **修复** 手部标记 Y 轴偏移 — 加头显位置补偿使标记贴合真实手腕位置
- **优化** 缩小手腕球体半径（6mm）和坐标轴尺寸（长 4cm / 粗 1mm），视觉更干净
- **优化** 手部追踪诊断面板每 5 秒刷新，显示 session/frame/inputSources 状态
- **SSL**：WebXR 要求 secure context，localhost 或 HTTPS（自签名可接受但需手动确认）
