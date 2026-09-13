// src/apps/Calculator.jsx
// ─────────────────────────────────────────────────────────────────────────────
// iOS Remastered — Calculator
//
// Calculadora iOS fiel:
//   • Display con auto-shrink: el número se reduce de tamaño según longitud.
//   • Teclado 4×5 en modo básico (dígitos, operadores, AC/±/%).
//   • Modo científico plegable (segundo panel superior con funciones).
//   • Historial de operaciones (long-press en el display).
//   • Formato de número localizado (separador de miles, coma decimal).
//   • Manejo de errores (división por cero → "Error").
//   • Animaciones: botón se oscurece al pulsar, AC↔C dinámico.
//   • Vibración háptica en cada tecla.
//
// Sin librerías externas.
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

function haptic(pattern = 'light') {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    const map = { light: 8, medium: 18, heavy: 32, tick: 4 };
    navigator.vibrate(map[pattern] || 8);
  }
}

/**
 * Formatea un número para mostrarlo en el display.
 * - Usa coma como separador decimal (locale es-ES).
 * - Añade separador de miles.
 * - Sin notación científica salvo que el número sea enorme.
 */
function formatNumber(raw) {
  if (raw === '' || raw == null) return '0';
  if (raw === 'Error') return 'Error';

  const str = String(raw);

  // Si ya tiene coma decimal, separamos parte entera y decimal
  const hasComma = str.includes(',');
  const [intPart, decPart] = str.split(',');

  // Manejar signo
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;

  // Separar miles con punto
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  const result = sign + grouped + (hasComma ? ',' + decPart : '');

  // Si es demasiado largo, notación científica
  if (result.replace(/[.,-]/g, '').length > 12) {
    const n = parseFloat(str.replace(',', '.'));
    if (Number.isFinite(n)) {
      return n.toExponential(5).replace('.', ',');
    }
  }
  return result;
}

/** Calcula el tamaño de fuente según longitud del texto. */
function fontSizeFor(text) {
  const len = String(text).length;
  if (len <= 6) return 88;
  if (len <= 8) return 76;
  if (len <= 10) return 64;
  if (len <= 12) return 54;
  if (len <= 14) return 46;
  if (len <= 16) return 40;
  return 34;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer de la calculadora
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL = {
  display: '0',           // string mostrado en el display
  accumulator: null,      // número acumulado (resultado previo)
  pendingOp: null,        // '+', '−', '×', '÷'
  fresh: true,            // si el siguiente dígito reemplaza el display
  history: [],            // array de { expression, result }
  error: false,
  second: false,          // si el modo "2nd" está activo (científico)
};

function reducer(state, action) {
  const { display, accumulator, pendingOp, fresh, history, error, second } = state;

  const parse = (s) => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));

  const applyOp = (a, b, op) => {
    switch (op) {
      case '+': return a + b;
      case '−': return a - b;
      case '×': return a * b;
      case '÷': return b === 0 ? 'Error' : a / b;
      default: return b;
    }
  };

  const toDisplay = (n) => {
    if (n === 'Error') return 'Error';
    if (!Number.isFinite(n)) return 'Error';
    // Limitar a 12 dígitos significativos
    const s = String(Number(n.toPrecision(12)));
    return s.replace('.', ',');
  };

  switch (action.type) {
    case 'DIGIT': {
      if (error) {
        return { ...INITIAL, second, display: action.digit === '0' ? '0' : action.digit, fresh: false };
      }
      if (fresh) {
        return { ...state, display: action.digit, fresh: false, error: false };
      }
      // Límite de longitud
      if (display.replace(/[.,-]/g, '').length >= 15) return state;
      if (display === '0') return { ...state, display: action.digit };
      return { ...state, display: display + action.digit };
    }

    case 'DECIMAL': {
      if (error) return { ...INITIAL, display: '0,', fresh: false };
      if (fresh) return { ...state, display: '0,', fresh: false };
      if (display.includes(',')) return state;
      return { ...state, display: display + ',' };
    }

    case 'SIGN': {
      if (error) return state;
      if (display === '0') return state;
      return {
        ...state,
        display: display.startsWith('-') ? display.slice(1) : '-' + display,
      };
    }

    case 'PERCENT': {
      if (error) return state;
      const n = parse(display);
      const result = n / 100;
      return { ...state, display: toDisplay(result), fresh: true };
    }

    case 'OP': {
      if (error) return state;
      const current = parse(display);
      let newAccum = current;

      if (accumulator != null && pendingOp && !fresh) {
        const r = applyOp(accumulator, current, pendingOp);
        if (r === 'Error') return { ...INITIAL, error: true, display: 'Error' };
        newAccum = r;
      } else if (accumulator != null && fresh) {
        // Cambiar el operador pendiente
        return { ...state, pendingOp: action.op, fresh: true };
      }

      return {
        ...state,
        accumulator: newAccum,
        pendingOp: action.op,
        display: toDisplay(newAccum),
        fresh: true,
      };
    }

    case 'EQ': {
      if (error) return state;
      if (accumulator == null || !pendingOp) {
        // No hay operación pendiente
        return { ...state, fresh: true };
      }
      const current = parse(display);
      const result = applyOp(accumulator, current, pendingOp);
      if (result === 'Error') {
        return { ...INITIAL, error: true, display: 'Error' };
      }
      const expr = `${toDisplay(accumulator)} ${pendingOp} ${toDisplay(current)}`;
      return {
        ...state,
        display: toDisplay(result),
        accumulator: null,
        pendingOp: null,
        fresh: true,
        history: [...history, { expression: expr, result: toDisplay(result) }].slice(-30),
      };
    }

    case 'CLEAR': {
      // AC limpia todo; C solo el display actual
      if (display === '0' || fresh) {
        return { ...INITIAL, second };
      }
      return { ...state, display: '0', fresh: false, error: false };
    }

    case 'ALL_CLEAR': {
      return { ...INITIAL, second };
    }

    case 'SECOND': {
      return { ...state, second: !second };
    }

    case 'CLEAR_HISTORY': {
      return { ...state, history: [] };
    }

    // Funciones científicas
    case 'FUNC': {
      if (error) return state;
      const n = parse(display);
      let r;
      switch (action.fn) {
        case 'sqrt':  r = Math.sqrt(n); break;
        case 'x2':    r = n * n; break;
        case 'x3':    r = n * n * n; break;
        case '1/x':   r = n === 0 ? 'Error' : 1 / n; break;
        case 'sin':   r = Math.sin(n); break;
        case 'cos':   r = Math.cos(n); break;
        case 'tan':   r = Math.tan(n); break;
        case 'ln':    r = n <= 0 ? 'Error' : Math.log(n); break;
        case 'log10': r = n <= 0 ? 'Error' : Math.log10(n); break;
        case 'pi':    r = Math.PI; break;
        case 'e':     r = Math.E; break;
        default:      r = n;
      }
      if (r === 'Error' || !Number.isFinite(r)) {
        return { ...INITIAL, error: true, display: 'Error' };
      }
      return { ...state, display: toDisplay(r), fresh: true };
    }

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes
// ─────────────────────────────────────────────────────────────────────────────

/** Botón de calculadora. */
function CalcButton({ label, kind = 'digit', onPress, wide = false, small = false }) {
  const [pressed, setPressed] = useState(false);

  const styles = useMemo(() => {
    const base = {
      height: small ? 48 : 76,
      borderRadius: 999,
      border: 'none',
      fontSize: small ? 18 : wide ? 26 : 32,
      fontWeight: 400,
      cursor: 'pointer',
      padding: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'filter 120ms ease, transform 80ms ease',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
      userSelect: 'none',
      WebkitTapHighlightColor: 'transparent',
      flex: wide ? 2.2 : 1,
    };
    switch (kind) {
      case 'digit':
        return { ...base, background: '#333333', color: '#fff' };
      case 'function':
        return { ...base, background: '#a5a5a5', color: '#000' };
      case 'operator':
        return { ...base, background: '#ff9f0a', color: '#fff' };
      case 'sci':
        return { ...base, background: '#1c1c1e', color: '#fff', fontSize: small ? 15 : 17 };
      default:
        return base;
    }
  }, [kind, wide, small]);

  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onClick={() => { haptic('tick'); onPress?.(); }}
      style={{
        ...styles,
        filter: pressed ? 'brightness(1.45)' : 'brightness(1)',
        transform: pressed ? 'scale(0.96)' : 'scale(1)',
      }}
      aria-label={label}
    >
      {label}
    </button>
  );
}

/** Historial desplegable. */
function HistoryPanel({ history, onClear }) {
  if (history.length === 0) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.9)',
          backdropFilter: 'blur(20px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255,255,255,0.5)',
          fontSize: 14,
          zIndex: 20,
        }}
      >
        Sin historial
      </div>
    );
  }
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.92)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        animation: 'calc-fade 200ms ease',
      }}
    >
      <div
        style={{
          padding: '60px 20px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>Historial</span>
        <button
          onClick={onClear}
          style={{
            background: 'rgba(255,59,48,0.2)',
            border: 'none',
            borderRadius: 14,
            padding: '6px 12px',
            color: '#ff453a',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Borrar
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {history.slice().reverse().map((h, i) => (
          <div
            key={i}
            style={{
              padding: '12px 0',
              borderBottom: '0.5px solid rgba(255,255,255,0.08)',
              textAlign: 'right',
            }}
          >
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>{h.expression} =</div>
            <div style={{ fontSize: 22, fontWeight: 500, color: '#fff', marginTop: 2 }}>
              {h.result}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Componente principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculator
 *
 * @param {Object} props
 * @param {Object} [props.os]
 * @param {Function} [props.onClose]
 */
export default function Calculator({ os, onClose }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [sciMode, setSciMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const longPressTimer = useRef(null);

  // ── Manejo del botón AC/C ─────────────────────────────────────────────────
  const clearLabel = state.error || state.display !== '0' || state.fresh ? 'AC' : 'C';
  const handleClear = () => {
    if (clearLabel === 'AC') dispatch({ type: 'ALL_CLEAR' });
    else dispatch({ type: 'CLEAR' });
  };

  // ── Long-press en el display → historial ──────────────────────────────────
  const onDisplayDown = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      haptic('medium');
      setShowHistory(true);
    }, 520);
  }, []);
  const onDisplayUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // ── Tamaño de fuente adaptativo ───────────────────────────────────────────
  const displayText = state.error ? 'Error' : formatNumber(state.display);
  const displaySize = useMemo(() => fontSizeFor(displayText), [displayText]);

  // ── Operador activo (para resaltarlo) ─────────────────────────────────────
  const isOpActive = (op) => state.pendingOp === op && state.fresh;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#000',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes calc-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>

      {/* Toggle científico + status */}
      <div
        style={{
          paddingTop: 58,
          paddingLeft: 16,
          paddingRight: 16,
          paddingBottom: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => { haptic('light'); setSciMode((v) => !v); }}
          style={{
            background: 'rgba(120,120,128,0.24)',
            border: 'none',
            borderRadius: 14,
            padding: '5px 12px',
            color: sciMode ? '#ff9f0a' : '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M3 9 h18 M3 15 h18 M9 3 v18 M15 3 v18" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Científica
        </button>
        {state.history.length > 0 && (
          <button
            onClick={() => { haptic('light'); setShowHistory(true); }}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.55)',
              fontSize: 12,
              cursor: 'pointer',
              padding: 6,
            }}
          >
            Historial
          </button>
        )}
      </div>

      {/* Panel científico */}
      {sciMode && (
        <div
          style={{
            padding: '8px 14px 4px',
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 6,
            animation: 'calc-fade 200ms ease',
          }}
        >
          {[
            { l: '2nd', fn: 'second' },
            { l: 'x²', fn: 'x2' },
            { l: 'x³', fn: 'x3' },
            { l: 'xʸ', fn: null },
            { l: 'eˣ', fn: null },
            { l: '10ˣ', fn: null },
            { l: '1/x', fn: '1/x' },
            { l: '√x', fn: 'sqrt' },
            { l: '∛x', fn: null },
            { l: 'ln', fn: 'ln' },
            { l: 'log₁₀', fn: 'log10' },
            { l: 'sin', fn: 'sin' },
            { l: 'cos', fn: 'cos' },
            { l: 'tan', fn: 'tan' },
            { l: 'π', fn: 'pi' },
          ].map((b) => (
            <CalcButton
              key={b.l}
              label={b.l}
              kind="sci"
              small
              onPress={() => {
                if (b.fn === 'second') dispatch({ type: 'SECOND' });
                else if (b.fn) dispatch({ type: 'FUNC', fn: b.fn });
              }}
            />
          ))}
        </div>
      )}

      {/* Display */}
      <div
        onPointerDown={onDisplayDown}
        onPointerUp={onDisplayUp}
        onPointerLeave={onDisplayUp}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          padding: '0 22px 12px',
          minHeight: 120,
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            fontSize: displaySize,
            fontWeight: 300,
            lineHeight: 1,
            letterSpacing: -2,
            color: '#fff',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'clip',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            transition: 'font-size 180ms cubic-bezier(.22,1,.36,1)',
            transform: state.error ? 'none' : 'none',
          }}
        >
          {displayText}
        </div>
      </div>

      {/* Teclado */}
      <div
        style={{
          padding: '0 12px 34px',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          flexShrink: 0,
        }}
      >
        {/* Fila 1 */}
        <CalcButton label={clearLabel} kind="function" onPress={handleClear} />
        <CalcButton
          label={state.second ? 'x²' : '±'}
          kind="function"
          onPress={() => {
            if (state.second) dispatch({ type: 'FUNC', fn: 'x2' });
            else dispatch({ type: 'SIGN' });
          }}
        />
        <CalcButton label="%" kind="function" onPress={() => dispatch({ type: 'PERCENT' })} />
        <CalcButton
          label="÷"
          kind="operator"
          onPress={() => dispatch({ type: 'OP', op: '÷' })}
        />

        {/* Fila 2 */}
        <CalcButton label="7" onPress={() => dispatch({ type: 'DIGIT', digit: '7' })} />
        <CalcButton label="8" onPress={() => dispatch({ type: 'DIGIT', digit: '8' })} />
        <CalcButton label="9" onPress={() => dispatch({ type: 'DIGIT', digit: '9' })} />
        <CalcButton
          label="×"
          kind="operator"
          onPress={() => dispatch({ type: 'OP', op: '×' })}
        />

        {/* Fila 3 */}
        <CalcButton label="4" onPress={() => dispatch({ type: 'DIGIT', digit: '4' })} />
        <CalcButton label="5" onPress={() => dispatch({ type: 'DIGIT', digit: '5' })} />
        <CalcButton label="6" onPress={() => dispatch({ type: 'DIGIT', digit: '6' })} />
        <CalcButton
          label="−"
          kind="operator"
          onPress={() => dispatch({ type: 'OP', op: '−' })}
        />

        {/* Fila 4 */}
        <CalcButton label="1" onPress={() => dispatch({ type: 'DIGIT', digit: '1' })} />
        <CalcButton label="2" onPress={() => dispatch({ type: 'DIGIT', digit: '2' })} />
        <CalcButton label="3" onPress={() => dispatch({ type: 'DIGIT', digit: '3' })} />
        <CalcButton
          label="+"
          kind="operator"
          onPress={() => dispatch({ type: 'OP', op: '+' })}
        />

        {/* Fila 5 */}
        <CalcButton
          label="0"
          wide
          onPress={() => dispatch({ type: 'DIGIT', digit: '0' })}
        />
        <CalcButton label="," onPress={() => dispatch({ type: 'DECIMAL' })} />
        <CalcButton
          label="="
          kind="operator"
          onPress={() => dispatch({ type: 'EQ' })}
        />
      </div>

      {/* Historial overlay */}
      {showHistory && (
        <HistoryPanel
          history={state.history}
          onClear={() => { dispatch({ type: 'CLEAR_HISTORY' }); setShowHistory(false); }}
        />
      )}

      {/* Botón de cierre del historial */}
      {showHistory && (
        <button
          onClick={() => setShowHistory(false)}
          style={{
            position: 'absolute',
            bottom: 20,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(255,255,255,0.14)',
            border: 'none',
            borderRadius: 22,
            padding: '10px 22px',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            zIndex: 21,
          }}
        >
          Cerrar
        </button>
      )}

      {/* Home indicator */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 134,
          height: 5,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.85)',
          pointerEvents: 'none',
          zIndex: 25,
        }}
      />
    </div>
  );
}
