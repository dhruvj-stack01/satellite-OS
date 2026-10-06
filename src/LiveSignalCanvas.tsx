import { useEffect, useRef } from 'react'

export type SignalPoint = { timestamp: string; value: number; status?: string }

type Props = {
  points: SignalPoint[]
  latestValue: number | null
  unit: string
  windowSeconds: number
  status: 'connected' | 'gap' | 'paused'
  label: string
  color?: string
  warningValue?: number
}

export default function LiveSignalCanvas({ points, latestValue, unit, windowSeconds, status, label, color = '#39b7ff', warningValue }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dataRef = useRef({ points, latestValue, unit, windowSeconds, status, label, color, warningValue })

  useEffect(() => {
    dataRef.current = { points, latestValue, unit, windowSeconds, status, label, color, warningValue }
  }, [points, latestValue, unit, windowSeconds, status, label, color, warningValue])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    let frame = 0
    let width = 0
    let height = 0
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = rect.width
      height = rect.height
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const draw = (time: number) => {
      const data = dataRef.current
      const { points: samples, latestValue: latest, unit: suffix, windowSeconds: duration, status: linkStatus } = data
      const padding = { top: 22, right: 16, bottom: 26, left: 48 }
      const plotWidth = Math.max(1, width - padding.left - padding.right)
      const plotHeight = Math.max(1, height - padding.top - padding.bottom)
      const now = Date.now()
      const start = now - duration * 1000
      const visible = samples
        .map((point) => ({ ...point, ms: Date.parse(point.timestamp) }))
        .filter((point) => Number.isFinite(point.ms) && point.ms >= start - 1000 && point.ms <= now + 1000)
      const values = visible.map((point) => point.value)
      if (typeof latest === 'number') values.push(latest)
      let min = values.length ? Math.min(...values) : 0
      let max = values.length ? Math.max(...values) : 1
      const spread = Math.max(max - min, Math.abs(max) * 0.04, 0.05)
      min -= spread * 0.16
      max += spread * 0.16
      const xAt = (ms: number) => padding.left + ((ms - start) / (duration * 1000)) * plotWidth
      const yAt = (value: number) => padding.top + ((max - value) / (max - min)) * plotHeight

      context.clearRect(0, 0, width, height)
      context.fillStyle = '#050b14'
      context.fillRect(0, 0, width, height)
      context.font = '10px ui-monospace, SFMono-Regular, monospace'
      context.textBaseline = 'middle'
      for (let line = 0; line <= 4; line += 1) {
        const y = padding.top + (plotHeight * line) / 4
        const value = max - ((max - min) * line) / 4
        context.strokeStyle = 'rgba(148,163,184,.14)'
        context.setLineDash([2, 5])
        context.beginPath()
        context.moveTo(padding.left, y)
        context.lineTo(width - padding.right, y)
        context.stroke()
        context.setLineDash([])
        context.fillStyle = '#718096'
        context.textAlign = 'right'
        context.fillText(value.toFixed(Math.abs(max) < 10 ? 2 : 0), padding.left - 8, y)
      }
      if (typeof data.warningValue === 'number' && data.warningValue >= min && data.warningValue <= max) {
        const warningY = yAt(data.warningValue)
        context.strokeStyle = 'rgba(251,191,36,.8)'
        context.setLineDash([5, 5])
        context.beginPath()
        context.moveTo(padding.left, warningY)
        context.lineTo(width - padding.right, warningY)
        context.stroke()
        context.setLineDash([])
      }
      for (let line = 0; line <= 4; line += 1) {
        const x = padding.left + (plotWidth * line) / 4
        context.strokeStyle = 'rgba(148,163,184,.07)'
        context.beginPath()
        context.moveTo(x, padding.top)
        context.lineTo(x, height - padding.bottom)
        context.stroke()
        context.fillStyle = '#718096'
        context.textAlign = line === 0 ? 'left' : line === 4 ? 'right' : 'center'
        context.fillText(`${Math.round((duration * (line - 4)) / 4)}s`, x, height - 11)
      }

      const lastSample = visible[visible.length - 1]
      const packetAge = lastSample ? now - lastSample.ms : Infinity
      const gapStart = linkStatus === 'gap' ? (lastSample?.ms ?? now) : packetAge > 750 ? (lastSample?.ms ?? now) : null
      const connectedPoints = gapStart === null ? visible : visible.filter((point) => point.ms <= gapStart)
      context.beginPath()
      connectedPoints.forEach((point, index) => {
        const x = xAt(point.ms)
        const y = yAt(point.value)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      if (connectedPoints.length > 0 && gapStart === null && linkStatus === 'connected') {
        const latestPoint = connectedPoints[connectedPoints.length - 1]
        const interp = latest ?? latestPoint.value
        context.lineTo(xAt(now), yAt(interp))
      }
      context.strokeStyle = data.color
      context.lineWidth = 2
      context.shadowColor = data.color
      context.shadowBlur = 8
      context.stroke()
      context.shadowBlur = 0

      if (connectedPoints.length > 0) {
        const latestPoint = connectedPoints[connectedPoints.length - 1]
        const currentValue = linkStatus === 'connected' && typeof latest === 'number' ? latest : latestPoint.value
        const dotX = Math.min(width - padding.right, Math.max(padding.left, xAt(linkStatus === 'connected' ? now : latestPoint.ms)))
        const dotY = yAt(currentValue)
        const pulse = 3 + (Math.sin(time / 180) + 1) * 1.2
        context.beginPath()
        context.arc(dotX, dotY, pulse, 0, Math.PI * 2)
        context.fillStyle = data.color
        context.shadowColor = data.color
        context.shadowBlur = 14
        context.fill()
        context.shadowBlur = 0
      }

      if (gapStart !== null) {
        const gapX = xAt(gapStart)
        context.fillStyle = 'rgba(245,158,11,.09)'
        context.fillRect(gapX, padding.top, Math.max(0, width - padding.right - gapX), plotHeight)
        context.strokeStyle = 'rgba(251,191,36,.82)'
        context.setLineDash([4, 4])
        context.beginPath()
        context.moveTo(gapX, padding.top)
        context.lineTo(gapX, height - padding.bottom)
        context.stroke()
        context.setLineDash([])
        context.fillStyle = '#fcd34d'
        context.textAlign = 'center'
        context.fillText('TELEMETRY GAP · NO NEW DATA', Math.max(padding.left + 100, (gapX + width - padding.right) / 2), padding.top + 17)
      }
      context.fillStyle = '#cbd5e1'
      context.textAlign = 'left'
      context.fillText(`${data.label.toUpperCase()}  ${latest?.toFixed(2) ?? '--'} ${suffix}`, padding.left, 10)
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} role="img" aria-label={`${label} live telemetry graph, ${windowSeconds}-second window`} className="h-full w-full" />
}
