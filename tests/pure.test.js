// Tests de las funciones puras de pure.js (RUT, plata, fechas) -- son
// justo las funciones donde una regresión silenciosa importa más: afectan
// el CSV que se importa en Kame (accounting real), y la validación de RUT
// que decide si se guarda o se rechaza un ítem/persona. No requieren
// navegador ni Supabase: corren con "npm test" (node --test).
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatearRut, validarRut, fmtCLP, fmtDate, fmtDateSlash, parseMoneyValue } = require("../pure.js");

test("formatearRut agrega puntos de miles y guión", () => {
  assert.equal(formatearRut("213153226"), "21.315.322-6");
  assert.equal(formatearRut("21315322-6"), "21.315.322-6");
  assert.equal(formatearRut("5000000k"), "5.000.000-K");
});

test("formatearRut no rompe con entradas cortas o vacías", () => {
  assert.equal(formatearRut(""), "");
  assert.equal(formatearRut("5"), "5");
});

test("validarRut acepta un RUT con dígito verificador correcto", () => {
  // 21.315.322-6 es un RUT real con DV válido (algoritmo módulo 11).
  assert.equal(validarRut("21.315.322-6"), true);
  assert.equal(validarRut("213153226"), true);
});

test("validarRut rechaza un dígito verificador incorrecto", () => {
  assert.equal(validarRut("21.315.322-5"), false);
  assert.equal(validarRut("21.315.322-0"), false);
});

test("validarRut rechaza entradas vacías o demasiado cortas", () => {
  assert.equal(validarRut(""), false);
  assert.equal(validarRut("5"), false);
});

test("fmtCLP formatea con separador de miles y sin decimales", () => {
  assert.equal(fmtCLP(1234567), "$1.234.567");
  assert.equal(fmtCLP(0), "$0");
  assert.equal(fmtCLP(null), "$0");
  assert.equal(fmtCLP(999.6), "$1.000"); // redondea
});

test("fmtDate lee una fecha YYYY-MM-DD como fecha de calendario local (sin corrimiento de día)", () => {
  // Este es justo el bug real que motivó el comentario en el código: pasar
  // "2026-01-31" directo a `new Date()` la interpreta como medianoche UTC,
  // que en Chile cae un día antes. fmtDate debe devolver el 31, no el 30.
  assert.equal(fmtDate("2026-01-31"), "31-01-2026");
  assert.equal(fmtDate(""), "");
  assert.equal(fmtDate(null), "");
});

test("fmtDateSlash da DD/MM/AAAA (formato que espera el importador de Kame)", () => {
  assert.equal(fmtDateSlash("2026-01-31"), "31/01/2026");
});

test("parseMoneyValue extrae solo los dígitos de un input formateado", () => {
  assert.equal(parseMoneyValue("1.234.567"), 1234567);
  assert.equal(parseMoneyValue("$45.000"), 45000);
  assert.equal(parseMoneyValue(""), 0);
  assert.equal(parseMoneyValue(null), 0);
});
