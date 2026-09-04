//! 请求调试捕获（临时 debug 用）相关的 Tauri 命令
//!
//! 纯内存、不落盘：开关 + 快照读取 + 清空。数据与实现在
//! `crate::proxy::debug_capture`，这里只是把全局态暴露给前端。

use crate::proxy::debug_capture::{self, CaptureEvent};

/// 读取当前捕获开关状态。
#[tauri::command]
pub fn get_debug_capture_enabled() -> bool {
    debug_capture::is_enabled()
}

/// 开/关请求调试捕获。开启后代理在关键点捕获出站请求体 / 非流式响应体 / 错误体。
#[tauri::command]
pub fn set_debug_capture_enabled(enabled: bool) -> bool {
    debug_capture::set_enabled(enabled);
    debug_capture::is_enabled()
}

/// 读取捕获快照（按时间升序）。前端轮询此命令刷新面板。
#[tauri::command]
pub fn get_debug_capture_events() -> Vec<CaptureEvent> {
    debug_capture::snapshot()
}

/// 清空捕获缓冲，返回被清空条数。
#[tauri::command]
pub fn clear_debug_capture() -> usize {
    debug_capture::clear()
}
