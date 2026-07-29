# CLAUDE.md — XNeroWebVR

基于 WebXR 的 VR 遥操作（teleoperation）双机械臂控制系统。通过 Meta Quest 3 浏览器采集手柄和手部追踪数据，WebSocket 实时传输给 Python 后端，输出 MediaPipe 兼容的 21 点手部 landmarks。

## 项目结构

```
XNeroWebVR/
├── vr_monitor.py              # 应用入口（可移植到任意目录独立使用）
├── config.yaml                # 运行时配置
├── cert.pem / key.pem         # SSL 自签名证书（WebXR 要求 HTTPS）
├── requirements.txt           # Python 依赖
├── web-ui/                    # VR 头显浏览器前端
│   ├── index.html             # A-Frame WebXR 场景 + 桌面 UI + 手部可视化实体
│   ├── vr_app.js              # 核心：控制器/手部数据采集、WebSocket 发送、3D 可视化
│   ├── interface.js           # 桌面端 UI 逻辑（设置面板、键盘控制、状态轮询）
│   ├── styles.css             # 全部样式
│   └── media/                 # 说明图片
└── xnero_webvr/               # Python 核心库
    ├── config.py              # XNeroWebVRConfig dataclass，YAML 配置加载
    ├── utils.py               # SSL 证书自动生成
    └── inputs/
        ├── base.py            # 数据结构：ControlGoal, HandJoint, HandData, ControlMode
        └── vr_ws_server.py    # WebSocket 服务器，解析 VR 数据生成 ControlGoal
```

## 架构与数据流

```
Quest 3 浏览器 (index.html + vr_app.js)
  │  A-Frame controller-updater 组件每帧 tick():
  │  ├─ 手柄 6DoF (position, quaternion, trigger, thumbstick, buttons)
  │  ├─ 头显 6DoF
  │  └─ 手部追踪 (WebXR Hand API → 25 关节 → MediaPipe 21 landmarks)
  │
  ▼ WSS :8442  JSON
Python 后端 (vr_monitor.py)
  ├─ SimpleHTTPSServer :8443  → 提供 web-ui/ 静态文件
  ├─ VRWebSocketServer :8442 → 接收/解析，生成 ControlGoal
  └─ asyncio.Queue → get_left_goal_nowait() / get_left_hand_nowait() API
```

## 命令

### 启动 VR 监控
```bash
python vr_monitor.py
```

### 安装依赖
```bash
pip install -r requirements.txt
```
依赖：`numpy`, `torch`, `scipy`, `websockets`, `pyyaml`, `pynput`

### 配置
编辑 `config.yaml`，核心字段：
- `vr.input_mode`: `controller` | `hand` | `both`
- `network.https_port`: 8443
- `network.websocket_port`: 8442

## 关键代码路径

### Python 后端

**`vr_monitor.py`** — 入口 + `VRMonitor` 类
- `setup_xnero_webvr_environment()`: 将 `XNERO_WEBVR_PATH` 加入 `sys.path`，`os.chdir()` 切换工作目录
- `SimpleAPIHandler` (HTTP): 只处理 GET，从 `web-ui/` 目录 serve 静态文件，添加 CORS 头
- `SimpleHTTPSServer`: 在独立线程运行 `http.server.HTTPServer`，用 `cert.pem`/`key.pem` 启用 SSL
- `VRMonitor`: 主控制器类
  - `initialize()`: 创建 `XRWebVRConfig` → `VRWebSocketServer` → `SimpleHTTPSServer`
  - `start_monitoring()`: 启动 HTTPS + WS 服务器，进入 `monitor_commands()` 循环
  - `monitor_commands()`: 从 `asyncio.Queue` 读取 `ControlGoal`，按 `arm` 类型分存到 `self.left_goal` / `self.right_goal` / `self.headset_goal`，同时从 `metadata['hand_data']` 提取手部 landmarks
  - `get_left_goal_nowait()` / `get_right_goal_nowait()` / `get_left_hand_nowait()` / `get_right_hand_nowait()`: 线程安全的只读 API

**`xnero_webvr/config.py`**
- `DEFAULT_CONFIG`: 嵌套 dict，所有字段的默认值
- `load_config()`: YAML → deep merge 到 defaults
- `XNeroWebVRConfig` dataclass: 类型化配置对象，含 `ssl_files_exist` / `ensure_ssl_certificates()` / `webapp_exists` 等 property
- 模块级常量 (`HTTPS_PORT`, `WEBSOCKET_PORT` 等): 向后兼容

**`xnero_webvr/utils.py`**
- `generate_ssl_certificates()`: 调用 `openssl req -x509` 生成自签名证书，设置 `0o600`/`0o644` 权限
- `ensure_ssl_certificates()`: 检查 → 不存在则调用生成

**`xnero_webvr/inputs/base.py`** — 数据结构
- `ControlMode(Enum)`: `POSITION_CONTROL` | `HAND_CONTROL` | `IDLE`
- `HandJoint`: `name`, `position` (np.ndarray 3,), `orientation` (np.ndarray 4, quaternion x,y,z,w), `radius`
- `HandData`: `hand` ("left"/"right"), `joints` (dict[str, HandJoint]), `timestamp`
  - 方法: `get_wrist()`, `get_finger_tips()`
- `ControlGoal`: `arm` ("left"/"right"/"headset"), `mode`, `target_position`, `wrist_roll_deg`, `wrist_flex_deg`, `gripper_closed`, `metadata`
- `BaseInputProvider(ABC)`: `command_queue`, `start()`, `stop()`, `send_goal()`

**`xnero_webvr/inputs/vr_ws_server.py`** — WebSocket 核心
- `VRWebSocketServer(BaseInputProvider)`:
  - `__init__`: 接收 `input_mode` ("controller"/"hand"/"both")，初始化左右 `VRControllerState` + 左右 `hand_state`
  - `start()`: `websockets.serve(ssl=...)` 在 `wss://host:websocket_port` 监听
  - `websocket_handler()`: JSON 解码 → `process_controller_data()`
  - `process_controller_data()`: 先处理 headset 数据 → 然后根据 `input_mode` 决定处理 controller 和/或 hand 数据
  - `process_single_controller()`: 手柄 6DoF 位姿 → 设置 origin → 计算 rotation (roll/pitch from quaternion) → 生成 `ControlGoal`
  - `process_hand_data()`: 将 wrist 关节 6DoF 包装成 synthetic controller data，调用 `process_single_controller()`，附 `_hand_data` 到 metadata
  - `VRControllerState`: 维护 origin position/quaternion、accumulated rotation、z_axis_rotation (roll)、x_axis_rotation (pitch)
  - 四元数工具: `euler_to_quaternion()`, `extract_roll_from_quaternion()`, `extract_pitch_from_quaternion()`

### 浏览器前端

**`web-ui/index.html`** — A-Frame 场景结构
```html
<a-scene vr-mode-ui="enabled: true;">
  <a-entity webxr-passthrough>           <!-- Quest 穿透模式 -->
  <a-entity id="headset" camera>          <!-- 头显追踪 + 信息文字 -->
  <a-entity id="leftHand" oculus-touch-controls="hand: left">   <!-- 左手柄 -->
  <a-entity id="rightHand" oculus-touch-controls="hand: right"> <!-- 右手柄 -->
  <a-entity id="leftHandMarker">          <!-- 左手腕可视化：球 + RGB 轴 + 文字 -->
  <a-entity id="rightHandMarker">         <!-- 右手腕可视化 -->
  <a-text id="handStatusText">            <!-- 手部追踪诊断面板 -->
```
- 桌面 UI 层 (`desktop-interface`): 状态面板、键盘控制按钮、设置模态框、VR 操作说明
- VR 内容层 (`vr-content`): VR 模式下显示 "VR Teleoperation"

**`web-ui/vr_app.js`** — 核心组件 `controller-updater`
- `init()`:
  1. Monkey-patch `navigator.xr.requestSession` 强制注入 `hand-tracking` optional feature
  2. 获取 DOM 引用: `#leftHand`, `#rightHand`, `#headset`, info text 实体
  3. 建立 WebSocket 连接到 `wss://<hostname>:8442`
  4. 绑定手柄事件: `triggerdown/up`, `gripdown/up`（含 grip release/trigger release 消息）
  5. `createAxisIndicators()`: 为左右手柄创建 RGB XYZ 轴（圆柱+锥形）
  6. `createHandVisualizers()`: 获取 HTML 中手部可视化实体引用 + 创建 21 关节微型轴
  7. `_createJointAxes('left'/'right')`: 21 个 `<a-entity>` 每个含 3 根微型 RGB 圆柱
- `tick()` (每帧):
  1. 强制 `object3D.visible = true`（防止 A-Frame 因未检测到手柄而隐藏实体）
  2. 采集左/右手柄数据: position, quaternion, trigger, thumbstick, buttons（从 `tracked-controls` gamepad）
  3. 采集头显数据
  4. 手部追踪采集:
     - 请求 `local` 参考空间
     - 遍历 `session.inputSources` → `inputSource.hand` → `h.entries()` 获取 25 关节
     - `getJointPose(js, localRefSpace)` → `joints` dict（local 空间，发服务端）
     - `getJointPose(js, sceneRefSpace)` → `jointsScene` dict（场景空间，3D 可视化）
     - `convertToMediaPipe()`: WebXR 25 关节 → MediaPipe 21 landmarks（跳过 4 个 metacarpal）
     - 每 5 秒更新 `handStatusText` 诊断面板
  5. `_updateHandVis()`: 更新手腕标记位置（场景空间坐标直接使用）
  6. `_updateJointAxes()`: 更新 21 关节微型轴位置
  7. WebSocket 发送 JSON 包（含 controller + headset + hand 数据 + `_handDebug`）
- 坐标系转换关键点:
  - **WebSocket 数据**使用 `local` 参考空间（原点 = 头显，单位米，+Y 上，-Z 前）
  - **3D 可视化**使用场景参考空间（`local-floor`，原点 = 地面）
  - 通过 `xrFrame.getJointPose(js, sceneRefSpace)` 直接在场景空间获取位姿，避免手动转换

**`web-ui/interface.js`** — 桌面 UI
- `openSettings()` / `closeSettings()` / `loadConfiguration()` / `saveConfiguration()`: 设置面板 CRUD
- `updateStatus()`: 每 2 秒轮询 `/api/status`，更新机械臂/VR/键盘状态指示灯
- `toggleKeyboardControl()` / `toggleRobotEngagement()`: 控制开关
- `sendKeyCommand()`: Web 键盘控制（WASD=左臂, IJKL=右臂），通过 `/api/keypress` POST
- `updateUIForDevice()`: 检测是否 VR 设备 → 切换显示桌面 UI 或 VR 界面

**`web-ui/styles.css`** — 全部样式
- 桌面界面、状态指示灯（绿/红）、设置模态框、键盘帮助面板、响应式布局

## 数据格式

### WebSocket JSON（浏览器 → Python）

```javascript
{
  "timestamp": 1700000000000,
  "leftController": {
    "hand": "left",
    "position":  { "x":0, "y":0, "z":0 },       // local 空间，米
    "quaternion":{ "x":0, "y":0, "z":0, "w":1 },
    "trigger": 0,                                // 0~1
    "gripActive": false,
    "thumbstick": { "x":0, "y":0 },
    "buttons": { "a":false, "b":false, "squeeze":false, "thumbstick":false, "menu":false }
  },
  "rightController": { /* 同上 */ },
  "headset": {
    "position":  { "x":0, "y":0, "z":0 },
    "quaternion":{ "x":0, "y":0, "z":0, "w":1 }
  },
  "leftHand": {
    "hand": "left",
    "landmarks": [                       // MediaPipe 21 点
      { "x":-0.14, "y":-0.24, "z":-0.33 },  // 0: WRIST
      // ... 共 21 个
    ],
    "wrist": {                           // 腕关节 6DoF
      "position":  { "x":-0.14, "y":-0.24, "z":-0.33 },
      "quaternion":{ "x":0.32, "y":-0.13, "z":0.19, "w":0.92 },
      "radius": 0.005
    }
  },
  "rightHand": { /* 同上 */ },
  "_handDebug": { /* session/frame/inputSources 诊断信息 */ }
}
```

### Python ControlGoal

| 字段 | 类型 | 说明 |
|------|------|------|
| `arm` | `"left"` `"right"` `"headset"` | 来源 |
| `mode` | `ControlMode` | POSITION_CONTROL / HAND_CONTROL / IDLE |
| `target_position` | `np.ndarray (3,)` | 目标位置（机器人坐标系） |
| `wrist_roll_deg` | `float` | 手腕翻滚角（度） |
| `wrist_flex_deg` | `float` | 手腕俯仰角（度） |
| `gripper_closed` | `bool` | 夹爪状态 |
| `metadata` | `dict` | 含 `hand_data`（21 landmarks）、`source`、`vr_position` 等 |

### MediaPipe 21 点 → WebXR 关节映射

| MP 索引 | MP 名称 | WebXR 关节名 |
|---------|---------|-------------|
| 0 | WRIST | wrist |
| 1 | THUMB_CMC | thumb-metacarpal |
| 2 | THUMB_MCP | thumb-phalanx-proximal |
| 3 | THUMB_IP | thumb-phalanx-distal |
| 4 | THUMB_TIP | thumb-tip |
| 5-8 | INDEX | index-finger-phalanx-proximal/intermediate/distal, index-finger-tip |
| 9-12 | MIDDLE | middle-finger-phalanx-proximal/intermediate/distal, middle-finger-tip |
| 13-16 | RING | ring-finger-phalanx-proximal/intermediate/distal, ring-finger-tip |
| 17-20 | PINKY | pinky-finger-phalanx-proximal/intermediate/distal, pinky-finger-tip |

> WebXR 25 关节中多出 4 个 metacarpal 在转换时被跳过。

## 坐标系统

```
WebXR / Three.js 右手坐标系:
    +Y (上)
    │  左手(-X)    右手(+X)
    │    🤚          🤚
    └─────── +X (右)
   /
  /
 -Z (前，远离身体)
```

- 单位：米
- 四元数顺序：`(x, y, z, w)` — Three.js / WebXR / scipy 标准
- 参考空间:
  - `local`: 原点 = 头显位置（VR 会话启动时），数据发给 Python 后端用
  - `local-floor`: 原点 = 地面，A-Frame 场景渲染用

## 常见问题和解决方案

### WebXR 会话无法启动
- **现象**: `session=False frame=False inputSources=0`
- **原因**: 自签名证书被 Quest 浏览器阻止 WebXR
- **解决**: USB 连接 Quest → `adb reverse tcp:8443 tcp:8443 && adb reverse tcp:8442 tcp:8442` → 访问 `http://localhost:8443`

### 手部追踪不工作
- **原因**: Quest 系统设置未开启 / 手柄还在手里
- **解决**: Quest 设置 → 运动追踪 → 开启手部和身体追踪 → 手柄放桌上等 5 秒

### `getJointPose()` 返回 null
- **原因**: Quest 最新浏览器使用新规范 API，`XRPose.position` 已废弃
- **解决**: 代码兼容两种 API: `pose.position || (pose.transform && pose.transform.position)`

### Quest `XRHand` 不支持 `entries()`/`keys()`/`for-of`
- **原因**: Quest 浏览器的 `XRHand` 未实现可迭代接口
- **解决**: 使用硬编码 25 关节名列表 + `hand.get(name)` 逐个获取

### 浏览器中手部标记不显示 / 闪一下就消失
- **根因**: `local` 空间坐标（原点=头显）直接用于 `local-floor` 场景（原点=地面），Y 轴差约 1.6m
- **解决**: 通过 `xrFrame.getJointPose(wristJS, sceneRefSpace)` 直接在场景参考空间获取位姿

### 手部标记不在手腕位置而是偏移
- **根因**: `renderer.xr.getReferenceSpace()` 返回的场景空间与手部追踪的 `local` 空间原点不一致
- **解决**: 同上，使用 `getJointPose(js, sceneRefSpace)` 直接获取场景坐标

## 代码约定和注意事项

- **Python 端** `input_mode` 是服务端配置，控制如何处理接收到的数据。浏览器端始终同时采集手柄和手部数据
- **`_updateHandVis()`** 接收的 `wristJoint` 已经是场景空间坐标，直接设 `setAttribute('position', ...)` 即可，不需要加头显偏移
- **`_updateJointAxes()`** 接收的 `jointsScene` 也是场景空间坐标
- **XNERO_WEBVR_PATH**: `vr_monitor.py` 顶部的硬编码路径，部署到新环境需要修改
- **SSL 证书**: 首次运行如果 `cert.pem`/`key.pem` 不存在会自动生成（需要 openssl）
- **A-Frame 手柄可见性**: A-Frame 的 `oculus-touch-controls` 组件在未检测到手柄时会设置 `object3D.visible = false`，导致子元素（轴、文字）不渲染。项目中在 `tick()` 开头强制设回 `true`
- **WebSocket 端口**: 浏览器端硬编码 `8442`，需与服务端 `config.yaml` 保持一致
- **REST API 未实现**: `interface.js` 引用了 `/api/config`、`/api/status`、`/api/restart`、`/api/keypress`、`/api/keyboard`、`/api/robot` 等接口，但 `SimpleAPIHandler` 目前只 serve 静态文件，这些 API 返回 404。桌面 UI 的状态轮询、设置保存、键盘控制等功能暂时不可用

## TODO

- [ ] 视觉显示优化 — UI/UX 改进
- [ ] 关键数据展示优化 — 手腕位姿、关节角度直观呈现
- [ ] 坐标轴视觉效果优化 — 颜色/透明度/粗细调整
- [ ] FPS 显示 — VR 场景实时帧率
- [ ] TCP 有线连接 — USB 线降低延迟提高稳定性
- [ ] APK 打包 — 数据采集 + Ego 画面录制
