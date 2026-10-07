/**
 * abort.mjs — io 层共用的取消语义（内部辅助模块；不属于 INTERFACES 的冻结签名）
 *
 * 只做一件事：把 `AbortSignal` 变成**可预期**的异常。
 * 规则：取消抛出 `AbortError`，绝不返回半截结果——半截结果会被上层当成真实数据。
 */

/**
 * 构造取消异常。若 `signal.reason` 本身是 Error（`controller.abort(err)`），原样抛出。
 * @param {AbortSignal|undefined} signal
 * @returns {Error}
 */
export function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const err = new Error(
    '操作已被取消（AbortSignal）。这通常是调用方主动中止；若要拿到完整结果，请不要取消信号后重试。',
  )
  err.name = 'AbortError'
  return err
}

/**
 * 已取消则抛 `AbortError`，否则什么也不做。
 * @param {AbortSignal|undefined} signal
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * 校验「可选的 signal」参数形态，避免把错误推迟到某个 addEventListener 上。
 * @param {unknown} signal
 * @param {string} where 调用处名字，用于错误消息
 */
export function assertSignal(signal, where) {
  if (signal === undefined || signal === null) return
  if (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean') {
    throw new TypeError(
      `${where} 的 opts.signal 必须是 AbortSignal（或省略）。` +
        `收到 ${typeof signal}；请传 controller.signal，不要直接传 controller。`,
    )
  }
}
