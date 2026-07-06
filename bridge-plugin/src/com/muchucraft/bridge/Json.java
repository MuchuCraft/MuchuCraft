package com.muchucraft.bridge;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal strict JSON (RFC 8259): parse → Map/List/String/BigDecimal/Boolean/null,
 * write the same shapes back. No runtime deps beyond the JDK, numbers never floats.
 */
final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    static Object parse(String text) {
        Json p = new Json(text);
        Object v = p.value(0);
        p.ws();
        if (p.i != p.s.length()) throw err("trailing garbage");
        return v;
    }

    static String write(Object v) {
        StringBuilder sb = new StringBuilder();
        writeValue(v, sb);
        return sb.toString();
    }

    static String error(String message) {
        return write(Map.of("error", message));
    }

    // ---- writer ----

    private static void writeValue(Object v, StringBuilder sb) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String str) {
            writeString(str, sb);
        } else if (v instanceof Boolean || v instanceof BigDecimal || v instanceof Integer || v instanceof Long) {
            sb.append(v);
        } else if (v instanceof Map<?, ?> map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(String.valueOf(e.getKey()), sb);
                sb.append(':');
                writeValue(e.getValue(), sb);
            }
            sb.append('}');
        } else if (v instanceof List<?> list) {
            sb.append('[');
            for (int k = 0; k < list.size(); k++) {
                if (k > 0) sb.append(',');
                writeValue(list.get(k), sb);
            }
            sb.append(']');
        } else {
            throw new IllegalArgumentException("unwritable type: " + v.getClass());
        }
    }

    private static void writeString(String str, StringBuilder sb) {
        sb.append('"');
        for (int k = 0; k < str.length(); k++) {
            char c = str.charAt(k);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append('"');
    }

    // ---- parser ----

    private Object value(int depth) {
        if (depth > 32) throw err("too deeply nested");
        ws();
        if (i >= s.length()) throw err("unexpected end");
        char c = s.charAt(i);
        return switch (c) {
            case '{' -> object(depth);
            case '[' -> array(depth);
            case '"' -> string();
            case 't' -> literal("true", Boolean.TRUE);
            case 'f' -> literal("false", Boolean.FALSE);
            case 'n' -> literal("null", null);
            default -> number();
        };
    }

    private Map<String, Object> object(int depth) {
        i++; // '{'
        Map<String, Object> out = new LinkedHashMap<>();
        ws();
        if (peek() == '}') {
            i++;
            return out;
        }
        while (true) {
            ws();
            if (peek() != '"') throw err("expected string key");
            String key = string();
            ws();
            if (peek() != ':') throw err("expected ':'");
            i++;
            out.put(key, value(depth + 1));
            ws();
            char c = peek();
            i++;
            if (c == '}') return out;
            if (c != ',') throw err("expected ',' or '}'");
        }
    }

    private List<Object> array(int depth) {
        i++; // '['
        List<Object> out = new ArrayList<>();
        ws();
        if (peek() == ']') {
            i++;
            return out;
        }
        while (true) {
            out.add(value(depth + 1));
            ws();
            char c = peek();
            i++;
            if (c == ']') return out;
            if (c != ',') throw err("expected ',' or ']'");
        }
    }

    private String string() {
        i++; // '"'
        StringBuilder sb = new StringBuilder();
        while (true) {
            if (i >= s.length()) throw err("unterminated string");
            char c = s.charAt(i++);
            if (c == '"') return sb.toString();
            if (c == '\\') {
                if (i >= s.length()) throw err("bad escape");
                char e = s.charAt(i++);
                switch (e) {
                    case '"' -> sb.append('"');
                    case '\\' -> sb.append('\\');
                    case '/' -> sb.append('/');
                    case 'b' -> sb.append('\b');
                    case 'f' -> sb.append('\f');
                    case 'n' -> sb.append('\n');
                    case 'r' -> sb.append('\r');
                    case 't' -> sb.append('\t');
                    case 'u' -> {
                        if (i + 4 > s.length()) throw err("bad \\u escape");
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                    }
                    default -> throw err("bad escape '\\" + e + "'");
                }
            } else if (c < 0x20) {
                throw err("control char in string");
            } else {
                sb.append(c);
            }
        }
    }

    private BigDecimal number() {
        int start = i;
        if (peek() == '-') i++;
        while (i < s.length() && "0123456789.eE+-".indexOf(s.charAt(i)) >= 0) i++;
        try {
            return new BigDecimal(s.substring(start, i));
        } catch (NumberFormatException e) {
            throw err("invalid number");
        }
    }

    private Object literal(String word, Object v) {
        if (!s.startsWith(word, i)) throw err("invalid literal");
        i += word.length();
        return v;
    }

    private char peek() {
        if (i >= s.length()) throw err("unexpected end");
        return s.charAt(i);
    }

    private void ws() {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    private static IllegalArgumentException err(String message) {
        return new IllegalArgumentException("JSON: " + message);
    }
}
