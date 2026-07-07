import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemStack } from '../../types'
import { useInventoryContext } from '../../context/InventoryContext'
import { useScale } from '../../context/ScaleContext'
import { ItemCanvas } from '../ItemCanvas'
import { Tooltip } from '../Tooltip'
import { ItemTooltipBody } from '../Tooltip/ItemTooltipBody'
import tooltipStyles from '../Tooltip/Tooltip.module.css'
import { useMobile } from '../../hooks/useMobile'
import styles from './Slot.module.css'

/** MuchuCraft: empty-hand drag-to-move. Vanilla only drags while already
 * holding an item (distribute); web players expect to press an item, drag it
 * to another slot, and release. Shared across all Slot instances (same module)
 * so the destination slot's mouseUp can read the source slot's mouseDown. */
let emptyHandMove: { fromIndex: number; startX: number; startY: number } | null = null

/** Hotbar HUD long-press: first threshold drops one item; hold longer for whole stack. */
const HOTBAR_LONG_PRESS_DROP_ONE_MS = 420
const HOTBAR_LONG_PRESS_DROP_ALL_EXTRA_MS = 600

interface SlotProps {
  index: number
  item: ItemStack | null
  size?: number
  highlighted?: boolean
  disabled?: boolean
  resultSlot?: boolean
  label?: string
  className?: string
  style?: React.CSSProperties
  /** Remove slot background/border (e.g. for JEI items) */
  noBackground?: boolean
  /** When true, skip P-key / focus-swap UI and mobile two-tap swap (e.g. standalone hotbar HUD). */
  disableFocusSwap?: boolean
  /** Override default click behavior - when provided, calls this instead of sendAction */
  onClickOverride?: (button: 'left' | 'right' | 'middle', mode: 'normal' | 'shift' | 'double') => void
}

export function Slot({
  index,
  item,
  size,
  highlighted,
  disabled,
  resultSlot,
  label,
  className,
  style,
  noBackground,
  disableFocusSwap = false,
  onClickOverride,
}: SlotProps) {
  const {
    heldItem,
    sendAction,
    isDragging,
    dragSlots,
    dragButton,
    dragPreview,
    startDrag,
    addDragSlot,
    endDrag,
    cancelDrag,
    hoveredSlot,
    setHoveredSlot,
    activeNumberKey,
    pKeyActive,
    setPKeyActive,
    focusedSlot,
    setFocusedSlot,
    dragEndedRef,
    noPlaceholders,
  } = useInventoryContext()

  const { contentSize } = useScale()
  const isMobile = useMobile()
  const slotRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const lastClickTimeRef = useRef(0)
  const [mobileTouchPos, setMobileTouchPos] = useState({ x: 0, y: 0 })
  const [showTooltip, setShowTooltip] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [labelFontSize, setLabelFontSize] = useState<number | undefined>(undefined)
  // Slot div = item content area. Slot is already positioned inside the texture border by InventoryWindow.
  const renderSize = size ?? contentSize

  // Measure label text and scale font size if it exceeds slot bounds
  useEffect(() => {
    if (!label || item) {
      setLabelFontSize(undefined)
      return
    }
    const baseFontSize = Math.round(renderSize * 0.35)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setLabelFontSize(baseFontSize)
      return
    }
    // Use the same font family as the label
    ctx.font = `${baseFontSize}px 'Minecraft', monospace`
    const textWidth = ctx.measureText(label).width
    const maxWidth = renderSize * 0.9 // Leave 10% padding on each side
    if (textWidth <= maxWidth) {
      setLabelFontSize(baseFontSize)
    } else {
      // Scale down proportionally
      const scaleFactor = maxWidth / textWidth
      setLabelFontSize(Math.max(Math.round(baseFontSize * scaleFactor), Math.round(renderSize * 0.2))) // Min 20% of slot size
    }
  }, [label, item, renderSize])

  // Mobile touch — timer ref must exist before cleanup effect below
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  // Clean up long press timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    }
  }, [])

  const isHovered = hoveredSlot === index
  const isDragTarget = dragSlots.includes(index)
  const dragPreviewEntry = dragPreview.get(index)
  const isFocused = !disableFocusSwap && focusedSlot === index
  const showPKeyNumber = !disableFocusSwap && pKeyActive && index >= 0 && index <= 99

  // Keyboard number key while hovering (disabled on hotbar HUD)
  useEffect(() => {
    if (!isHovered || activeNumberKey === null || isMobile || disableFocusSwap) return
    sendAction({ type: 'hotbar-swap', slotIndex: index, hotbarSlot: activeNumberKey })
  }, [activeNumberKey, isHovered, index, sendAction, isMobile, disableFocusSwap])

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    if (isMobile) return
    setHoveredSlot(index)
    setShowTooltip(true)
    if (isDragging) addDragSlot(index)
  }, [isMobile, index, setHoveredSlot, isDragging, addDragSlot])

  const handleMouseLeave = useCallback(() => {
    if (isMobile) return
    setHoveredSlot(null)
    setShowTooltip(false)
  }, [isMobile, setHoveredSlot])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile || disabled) return
      e.preventDefault()
      dragEndedRef.current = false
      const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
      if (button === 'middle') {
        if (!disableFocusSwap) {
          sendAction({ type: 'click', slotIndex: index, button: 'middle', mode: 'middle' })
        }
        return
      }
      if (heldItem && (button === 'left' || button === 'right')) {
        // Don't start drag during double-click sequence
        if (Date.now() - lastClickTimeRef.current < 400) return
        startDrag(index, button)
      } else if (!heldItem && button === 'left' && item && !onClickOverride) {
        // MuchuCraft: empty hand + item under cursor → arm a drag-to-move.
        // Resolved (or discarded) by the destination slot's handleMouseUp.
        emptyHandMove = { fromIndex: index, startX: e.clientX, startY: e.clientY }
      }
    },
    [isMobile, disabled, disableFocusSwap, heldItem, index, sendAction, startDrag, dragEndedRef],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile || disabled) return
      e.preventDefault()
      e.stopPropagation()
      const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'

      // MuchuCraft: resolve an empty-hand drag-to-move. Consume the armed
      // source (clear it regardless so it can never go stale).
      const move = emptyHandMove
      emptyHandMove = null
      if (
        move && button === 'left' && !heldItem && !isDragging &&
        move.fromIndex !== index &&
        Math.hypot(e.clientX - move.startX, e.clientY - move.startY) > 6
      ) {
        // Same code path as two real clicks: lift from source, drop on target.
        sendAction({ type: 'click', slotIndex: move.fromIndex, button: 'left', mode: 'normal' })
        sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'normal' })
        return
      }

      if (isDragging && dragSlots.length > 1) {
        endDrag()
        return
      }

      // Suppress spurious mouseUp events that fire after a drag ends.
      // The browser can dispatch extra mouseUp events after endDrag resets isDragging;
      // without this guard they fall through to the click path below.
      if (dragEndedRef.current) return

      // Focus/swap logic — active in P mode OR when a slot is already focused (disabled for hotbar HUD)
      if (!disableFocusSwap && button === 'left' && (pKeyActive || focusedSlot !== null)) {
        if (pKeyActive) setPKeyActive(false)
        if (focusedSlot === null) {
          setFocusedSlot(index)
        } else if (focusedSlot === index) {
          setFocusedSlot(null)
        } else {
          sendAction({ type: 'click', slotIndex: focusedSlot, button: 'left', mode: 'normal' })
          sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'normal' })
          sendAction({ type: 'click', slotIndex: focusedSlot, button: 'left', mode: 'normal' })
          setFocusedSlot(null)
        }
        if (isDragging) endDrag()
        return
      }

      // Suppress the second mouseup of a double-click to prevent it from
      // putting the item back before the dblclick event fires mode=6.
      const now = Date.now()
      if (button === 'left' && now - lastClickTimeRef.current < 400) {
        lastClickTimeRef.current = 0
        return
      }
      lastClickTimeRef.current = now

      const mode = e.shiftKey ? 'shift' : 'normal'

      if (disableFocusSwap && !onClickOverride) {
        if (button === 'middle') {
          if (isDragging) endDrag()
          return
        }
        if (!heldItem && index >= 36 && index <= 44) {
          if (button === 'left' && mode === 'normal') {
            sendAction({ type: 'hotbar-select', slotIndex: index })
          }
          if (isDragging) endDrag()
          return
        }
      }

      if (onClickOverride) {
        onClickOverride(button, mode)
      } else {
        if (resultSlot && heldItem && !item && mode === 'normal') {
          // Cannot place items into result/output slots
        } else {
          if (button === 'left' || button === 'right') setShowTooltip(false)
          sendAction({ type: 'click', slotIndex: index, button, mode })
        }
      }
      if (isDragging) endDrag()
    },
    [isMobile, disabled, disableFocusSwap, isDragging, dragSlots.length, sendAction, index, endDrag, onClickOverride, resultSlot, heldItem, item, pKeyActive, setPKeyActive, focusedSlot, setFocusedSlot, dragEndedRef],
  )

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile || disabled) return
      e.preventDefault()
      cancelDrag()
      if (disableFocusSwap && !onClickOverride) return
      if (onClickOverride) {
        onClickOverride('left', 'double')
      } else {
        sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'double' })
      }
    },
    [isMobile, disabled, disableFocusSwap, sendAction, index, onClickOverride, cancelDrag],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (isMobile || disabled || disableFocusSwap) return
      if (onClickOverride) return // JEI slots: let parent handle wheel for pagination
      if (!item && !heldItem) return
      e.preventDefault()
      if (e.deltaY < 0 && item) {
        sendAction({ type: 'click', slotIndex: index, button: 'right', mode: 'normal' })
      } else if (e.deltaY > 0 && heldItem) {
        sendAction({ type: 'click', slotIndex: index, button: 'right', mode: 'normal' })
      }
    },
    [isMobile, disabled, disableFocusSwap, item, heldItem, sendAction, index, onClickOverride],
  )

  // Attach wheel listener as non-passive so preventDefault() is effective.
  // React 17+ registers wheel events at the root as passive, which prevents
  // calling preventDefault() from within React's onWheel synthetic handler.
  useEffect(() => {
    const el = slotRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile) return
      const touch = e.touches[0]
      touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
      longPressFiredRef.current = false
      cancelLongPress()
      // Hotbar HUD: staged long-press drops (no radial menu)
      if (disableFocusSwap && item && !heldItem && !disabled) {
        longPressTimerRef.current = setTimeout(() => {
          longPressFiredRef.current = true
          sendAction({ type: 'drop', slotIndex: index, all: false })
          longPressTimerRef.current = setTimeout(() => {
            sendAction({ type: 'drop', slotIndex: index, all: true })
            longPressTimerRef.current = null
          }, HOTBAR_LONG_PRESS_DROP_ALL_EXTRA_MS)
        }, HOTBAR_LONG_PRESS_DROP_ONE_MS)
        return
      }
      // Long press: open mobile menu after 400ms if item exists and no held item
      if (item && !heldItem && !disabled) {
        const startX = touch.clientX
        const startY = touch.clientY
        longPressTimerRef.current = setTimeout(() => {
          longPressFiredRef.current = true
          setMobileTouchPos({ x: startX, y: startY })
          setMobileMenuOpen(true)
        }, 400)
      }
    },
    [isMobile, item, heldItem, disabled, cancelLongPress, disableFocusSwap, sendAction, index],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!longPressTimerRef.current) return
      const touch = e.touches[0]
      const start = touchStartRef.current
      if (!start) return
      if (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10) {
        cancelLongPress()
      }
    },
    [cancelLongPress],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      cancelLongPress()
      if (!isMobile || disabled) return
      // If long press opened the menu, don't process the tap
      if (longPressFiredRef.current) {
        longPressFiredRef.current = false
        e.stopPropagation()
        e.preventDefault()
        return
      }
      // If mobile menu is open, let menu buttons handle their own events
      if (mobileMenuOpen) return
      const start = touchStartRef.current
      if (!start) return
      touchStartRef.current = null
      const touch = e.changedTouches[0]
      if (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10) return
      e.stopPropagation()
      // Prevent the browser from firing a synthetic click after touchEnd.
      // Without this, the click bubbles to the inventory window div which clears focusedSlot.
      e.preventDefault()

      if (pKeyActive && !disableFocusSwap) setPKeyActive(false)

      // JEI / recipe / custom slots: same handler as desktop onMouseUp (not focus/swap).
      if (onClickOverride) {
        onClickOverride('left', 'normal')
        return
      }

      if (heldItem) {
        // When holding an item, place it (standard behavior, no focus needed)
        if (focusedSlot !== null) setFocusedSlot(null)
        sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'normal' })
        return
      }

      if (disableFocusSwap) {
        if (focusedSlot !== null) setFocusedSlot(null)
        if (index >= 36 && index <= 44 && !heldItem) {
          sendAction({ type: 'hotbar-select', slotIndex: index })
        } else {
          sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'normal' })
        }
        return
      }

      // On mobile, tapping always uses the focus/swap mechanism:
      // first tap focuses, second tap on a different slot swaps, same slot clears.
      if (focusedSlot === null) {
        setFocusedSlot(index)
      } else if (focusedSlot === index) {
        setFocusedSlot(null)
      } else {
        sendAction({ type: 'click', slotIndex: focusedSlot, button: 'left', mode: 'normal' })
        sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'normal' })
        sendAction({ type: 'click', slotIndex: focusedSlot, button: 'left', mode: 'normal' })
        setFocusedSlot(null)
      }
    },
    [isMobile, disabled, disableFocusSwap, heldItem, sendAction, index, pKeyActive, setPKeyActive, focusedSlot, setFocusedSlot, onClickOverride, cancelLongPress, mobileMenuOpen],
  )

  const handleMobilePickAll = useCallback(() => {
    setMobileMenuOpen(false)
    setShowTooltip(false)
    if (!disableFocusSwap) setFocusedSlot(index)
    sendAction({ type: 'click', slotIndex: index, button: 'left', mode: 'normal' })
  }, [sendAction, index, setFocusedSlot, disableFocusSwap])

  const handleMobilePickHalf = useCallback(() => {
    setMobileMenuOpen(false)
    setShowTooltip(false)
    if (!disableFocusSwap) setFocusedSlot(index)
    sendAction({ type: 'click', slotIndex: index, button: 'right', mode: 'normal' })
  }, [sendAction, index, setFocusedSlot, disableFocusSwap])

  const handleMobileDropOne = useCallback(() => {
    setMobileMenuOpen(false)
    setShowTooltip(false)
    setFocusedSlot(null)
    sendAction({ type: 'drop', slotIndex: index, all: false })
  }, [sendAction, index, setFocusedSlot])

  const handleMobileDropAll = useCallback(() => {
    setMobileMenuOpen(false)
    setShowTooltip(false)
    setFocusedSlot(null)
    sendAction({ type: 'drop', slotIndex: index, all: true })
  }, [sendAction, index, setFocusedSlot])

  const closeMobileMenu = useCallback(() => {
    setMobileMenuOpen(false)
    setShowTooltip(false)
  }, [])

  return (
    <div
      ref={slotRef}
      className={[
        noBackground ? styles.slotBare : styles.slot,
        highlighted && styles.highlighted,
        disabled && styles.disabled,
        resultSlot && styles.resultSlot,
        isHovered && !isMobile && styles.hovered,
        isDragTarget && styles.dragTarget,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      tabIndex={index >= 0 ? 0 : undefined}
      data-slot={index}
      data-debug={item?.debugKey ?? undefined}
      data-texture={item?.textureKey ?? undefined}
      style={{
        width: renderSize,
        height: renderSize,
        position: 'relative',
        flexShrink: 0,
        ...(isFocused ? { outline: `2px dashed #ff0`, outlineOffset: -2, animation: 'mc-inv-focus-dash 0.5s linear infinite' } : {}),
        ...style,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      aria-label={
        label ??
        (item
          ? `Slot ${index}: ${item.displayName ?? item.name ?? item.type} ×${item.count}`
          : `Slot ${index} (empty)`)
      }
    >
      {item && (
        <ItemCanvas
          item={item}
          size={renderSize}
          noCount={!!dragPreviewEntry}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        />
      )}

      {!item && label && !noPlaceholders && (
        <div
          ref={labelRef}
          className={styles.emptyLabel}
          style={{ fontSize: labelFontSize ?? Math.round(renderSize * 0.35) }}
        >
          {label}
        </div>
      )}

      {showPKeyNumber && (
        <div
          className="mc-inv-pkey-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(255, 0, 0, 0.2)',
            border: '1px solid rgba(255, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingLeft: 4,
            pointerEvents: 'none',
            zIndex: 4,
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              fontSize: Math.round(renderSize * 0.4),
              fontFamily: "'Minecraftia', 'Minecraft', monospace",
              color: '#ffffff',
              textShadow: '1px 1px 0 rgba(0,0,0,0.7)',
              lineHeight: 1,
            }}
          >
            {String(index).padStart(2, '0')}
          </span>
        </div>
      )}

      {dragPreviewEntry && (
        <>
          {!item && heldItem && (
            <ItemCanvas
              item={heldItem}
              size={renderSize}
              noCount
              style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
            />
          )}
          <div
            className="mc-inv-drag-preview-count"
            style={{
              position: 'absolute',
              right: 1,
              bottom: 1,
              fontSize: Math.round(renderSize * 0.45),
              fontFamily: "'Minecraftia', 'Minecraft', monospace",
              color: '#ffff00',
              textShadow: '1px 1px 0 #3f3f00',
              lineHeight: 1,
              pointerEvents: 'none',
              zIndex: 3,
            }}
          >
            {dragPreviewEntry.count}
          </div>
        </>
      )}

      {item && showTooltip && !mobileMenuOpen && !heldItem && (
        <Tooltip item={item} visible />
      )}

      {isMobile && mobileMenuOpen && item && (
        <>
          <div
            className={styles.mobileOverlay}
            onClick={closeMobileMenu}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); closeMobileMenu() }}
          />
          <MobileSlotMenu
            item={item}
            x={mobileTouchPos.x}
            y={mobileTouchPos.y}
            onPickAll={handleMobilePickAll}
            onPickHalf={handleMobilePickHalf}
            onDropOne={handleMobileDropOne}
            onDropAll={handleMobileDropAll}
            onClose={closeMobileMenu}
          />
        </>
      )}
    </div>
  )
}

interface MobileSlotMenuProps {
  item: ItemStack
  x: number
  y: number
  onPickAll(): void
  onPickHalf(): void
  onDropOne(): void
  onDropAll(): void
  onClose(): void
}

function MobileSlotMenu({ item, x, y, onPickAll, onPickHalf, onDropOne, onDropAll, onClose }: MobileSlotMenuProps) {
  const { scale } = useScale()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    if (!menuRef.current) return
    const mw = menuRef.current.offsetWidth
    const mh = menuRef.current.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x + 8
    let top = y
    if (left + mw > vw - 4) left = x - mw - 8
    if (top + mh > vh - 4) top = vh - mh - 4
    if (top < 4) top = 4
    setPos({ left, top })
  }, [x, y, item])

  // Wrapper to handle both touch and click, preventing event bubbling to the slot
  const touchBtn = (handler: () => void) => ({
    onTouchEnd: (e: React.TouchEvent) => { e.stopPropagation(); e.preventDefault(); handler() },
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); handler() },
  })

  return (
    <div
      ref={menuRef}
      className={styles.mobileMenu}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 10001,
        fontSize: Math.round(9 * scale),
        padding: 6 * scale,
        gap: 4 * scale,
        minWidth: 100 * scale,
      }}
    >
      <div
        className={[tooltipStyles.tooltip, styles.mobileMenuInfo].join(' ')}
        style={{
          fontSize: Math.round(8 * scale),
          padding: Math.round(3 * scale),
          gap: Math.round(0.5 * scale),
          width: 'max-content',
          maxWidth: 'min(90vw, 280px)',
        }}
      >
        <ItemTooltipBody item={item} />
      </div>
      <button className={styles.mobileBtn} {...touchBtn(onPickAll)}>Select All ({item.count})</button>
      <button className={styles.mobileBtn} {...touchBtn(onPickHalf)}>Pick Half ({Math.ceil(item.count / 2)})</button>
      <button className={[styles.mobileBtn, styles.mobileBtnDanger].join(' ')} {...touchBtn(onDropOne)}>Drop One</button>
      <button className={[styles.mobileBtn, styles.mobileBtnDanger].join(' ')} {...touchBtn(onDropAll)}>Drop All</button>
    </div>
  )
}
