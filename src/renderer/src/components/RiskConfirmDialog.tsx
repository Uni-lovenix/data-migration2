import { useState, type ReactElement } from 'react'
import { AlertTriangle, X } from 'lucide-react'

import type { RiskNotice } from '../../../shared/risk-notices'

interface RiskConfirmDialogProps {
  notice: RiskNotice
  confirmLabel: string
  /** 需要用户逐字输入才能确认的标识（例如目标表名），用于不可逆操作。 */
  confirmText?: string
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * 破坏性操作的风险确认对话框。
 *
 * 确认结果不依赖这个组件自身的状态：调用方拿到 onConfirm 后必须把
 * riskAck（含文案版本）放进请求，主进程会再次校验版本是否过期。
 */
export function RiskConfirmDialog({
  notice,
  confirmLabel,
  confirmText,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: RiskConfirmDialogProps): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false)
  const [typed, setTyped] = useState('')
  const typedOk = confirmText === undefined || typed.trim() === confirmText
  const canConfirm = acknowledged && typedOk && !busy

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onCancel()
        }
      }}
    >
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="risk-title">
            <AlertTriangle size={18} />
            {notice.title}
          </h2>
          <button
            type="button"
            className="button button-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <p className="risk-summary">{notice.summary}</p>
          <ul className="risk-notice-list">
            {notice.items.map((item) => (
              <li key={item.label} className="risk-notice-item">
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </li>
            ))}
          </ul>

          {confirmText !== undefined ? (
            <div className="form-field">
              <label htmlFor="risk-confirm-text">
                请输入 <code>{confirmText}</code> 以确认
              </label>
              <input
                id="risk-confirm-text"
                type="text"
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          ) : null}

          <label className="risk-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>我已阅读并了解上述风险</span>
          </label>

          {error ? <div className="inline-error">{error}</div> : null}
          <p className="risk-version">风险提示版本：{notice.version}</p>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={!canConfirm}
            onClick={onConfirm}
          >
            {busy ? '执行中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
