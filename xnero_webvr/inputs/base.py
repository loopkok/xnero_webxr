"""
Base classes and data structures for input providers.
"""

import asyncio
import numpy as np
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional, Literal, Dict, Any
from enum import Enum

class ControlMode(Enum):
    """Control modes for the teleoperation system."""
    POSITION_CONTROL = "position"
    HAND_CONTROL = "hand"      # Hand tracking based control (wrist = end-effector)
    IDLE = "idle"


@dataclass
class HandJoint:
    """A single hand joint from WebXR Hand Tracking API.

    Attributes:
        name: Joint name per WebXR spec (e.g. "wrist", "index-finger-tip").
        position: 3D position (x, y, z) in the VR reference space (meters).
        orientation: Quaternion (x, y, z, w) in the VR reference space.
        radius: Estimated joint radius in meters (for visualization / collision).
    """
    name: str
    position: np.ndarray       # shape (3,) — x, y, z
    orientation: np.ndarray    # shape (4,) — x, y, z, w quaternion
    radius: float = 0.005      # default ~5 mm


@dataclass
class HandData:
    """Full hand tracking data for one hand (25 joints per WebXR spec).

    Attributes:
        hand: "left" or "right".
        joints: Dict keyed by joint name (e.g. "wrist", "thumb-tip", …).
        timestamp: Browser-side timestamp (ms) when this data was captured.
    """
    hand: str                               # "left" | "right"
    joints: dict = None                     # dict[str, HandJoint]
    timestamp: float = 0.0

    def __post_init__(self):
        if self.joints is None:
            self.joints = {}

    def get_wrist(self) -> Optional[HandJoint]:
        """Convenience: return the wrist joint if present."""
        return self.joints.get("wrist")

    def get_finger_tips(self) -> dict:
        """Return a dict of {finger_name: HandJoint} for the 5 finger tips."""
        tips = {}
        for finger in ["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"]:
            tip = self.joints.get(f"{finger}-tip")
            if tip is not None:
                tips[finger] = tip
        return tips

@dataclass
class ControlGoal:
    """High-level control goal message sent from input providers."""
    arm: Literal["left", "right"]
    mode: Optional[ControlMode] = None            # Control mode (None = no mode change)
    target_position: Optional[np.ndarray] = None  # 3D position in robot coordinates
    wrist_roll_deg: Optional[float] = None        # Wrist roll angle in degrees
    wrist_flex_deg: Optional[float] = None        # Wrist flex (pitch) angle in degrees
    gripper_closed: Optional[bool] = None         # Gripper state (None = no change)
    
    # Additional data for debugging/monitoring
    metadata: Optional[Dict[str, Any]] = None

class BaseInputProvider(ABC):
    """Abstract base class for input providers."""
    
    def __init__(self, command_queue: asyncio.Queue):
        self.command_queue = command_queue
        self.is_running = False
    
    @abstractmethod
    async def start(self):
        """Start the input provider."""
        pass
    
    @abstractmethod
    async def stop(self):
        """Stop the input provider."""
        pass
    
    async def send_goal(self, goal: ControlGoal):
        """Send a control goal to the command queue."""
        try:
            await self.command_queue.put(goal)
        except Exception as e:
            # Handle queue full or other errors
            pass 