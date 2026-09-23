// ============================================================
// Casos de prueba del lector de comprobantes (parsearTextoFactura).
//
// POR QUÉ EXISTE ESTE ARCHIVO
// Cada caso de acá abajo es texto REAL, tal cual lo devolvió pdf.js o el OCR
// sobre un documento que de verdad se rindió -- con sus erratas incluidas.
// No son ejemplos inventados: cada uno corresponde a una vez que el lector
// se equivocó, y varias de esas veces terminaron en un monto erróneo
// llegando a un campo que va a contabilidad.
//
// Ajustar un patrón del parser "a ojo" es fácil y arreglar un caso rompiendo
// otro es todavía más fácil: ya pasó varias veces (quitar el RUT del texto
// antes de buscar importes, cortar la descripción, el "no" que se comía el
// folio). Esto es lo que evita repetirlo.
//
// CÓMO SE CORRE
// Abrir la app y pegar en la consola del navegador:
//     correrPruebasLector()
// Devuelve un resumen y, si algo falla, qué esperaba y qué obtuvo.
// ============================================================

const CASOS_LECTOR = [
  // ----------------------------------------------------------
  // Montos: lo más caro de equivocar
  // ----------------------------------------------------------
  {
    nombre: "boleta ERSY: el OCR se comió un dígito del total",
    // Real. El total son $111.170 y el OCR leyó "TOTAL $ 11.179". Estaba
    // pegado a su etiqueta, así que pasó todas las defensas que había. Lo
    // que lo delata es el total en letras, que dice el número correcto.
    texto: "SUB TOTAL $ 111,179 TOTAL $ 11.179 NETO $ 93,921 TOTAL IVA 19048 SON: CIENTO ONCE MIL CIENTO SETENTA sUeEUEEAANAPUNTOS",
    espera: { monto_origen: "discrepancia", monto_en_foto: null },
  },
  {
    nombre: "letras y dígitos coinciden: monto confirmado",
    texto: "R.U.T. 96.505.760-9 TOTAL $ 47.600 SON: CUARENTA Y SIETE MIL SEISCIENTOS PESOS",
    espera: { monto: 47600, monto_origen: "palabras+digitos", monto_verificado: true },
  },
  {
    nombre: "letras rotas por el OCR: se descartan, no se inventan",
    // "OCHO MXL NOVECIENTOS" devolvía 8 y pisaba el monto correcto: el
    // parser se frenaba en la palabra ilegible y entregaba lo acumulado.
    texto: "R.U.T. 96.505.760-9 TOTAL $ 8.990 SON: OCHO MXL NOVECIENTOS",
    espera: { monto: 8990, monto_origen: "etiqueta" },
  },
  {
    nombre: "neto + IVA = total: confirmado por aritmética",
    texto: "FACTURA ELECTRONICA N° 136982 R.U.T. 96.505.760-9 Neto $ 40.000 IVA 19% $ 7.600 TOTAL $ 47.600",
    espera: { monto: 47600, monto_origen: "aritmetica", monto_verificado: true },
  },
  {
    nombre: "neto + IVA que NO cuadran al peso no confirman nada",
    // Real. Un comprobante de $16.940 se leyó $16.960 y salió CONFIRMADO por
    // aritmética: la tolerancia era del 1% del IVA, o sea decenas de pesos,
    // y ese margen alcanzaba para que el total mal leído encontrara un neto
    // que lo respaldara. Peor que un número suelto equivocado, porque lleva
    // el sello de confianza encima. Acá el IVA declarado se aparta 20 pesos
    // del que corresponde a ese neto.
    texto: "R.U.T. 96.505.760-9 Neto $ 14.235 IVA 19% $ 2.725 TOTAL $ 16.960",
    espera: { monto_verificado: false },
  },
  {
    nombre: "neto + IVA exactos sí confirman",
    texto: "R.U.T. 96.505.760-9 Neto $ 14.235 IVA 19% $ 2.705 TOTAL $ 16.940",
    espera: { monto: 16940, monto_origen: "aritmetica", monto_verificado: true },
  },
  {
    nombre: "tres números de referencia que cuadran por casualidad",
    // 136982 - 115277 = 21705, y round(115277 * 0.19) = 21903: entra en la
    // tolerancia. Sin exigir "$" o etiqueta, la aritmética devolvía $136.982
    // Y lo marcaba como confirmado, que es peor que un número suelto mal.
    texto: "FACTURA ELECTRONICA R.U.T. 96.505.760-9 Ref 136982 115277 21705 2026 1577 TOTAL $ 47.600 Neto $ 40.000 IVA $ 7.600",
    espera: { monto: 47600 },
  },
  {
    nombre: "moneda extranjera: no se lee como pesos",
    texto: "FACTURA ELECTRONICA N° 900 R.U.T. 96.505.760-9 TOTAL US$ 1.500",
    espera: { monto: null },
  },

  // ----------------------------------------------------------
  // Folio
  // ----------------------------------------------------------
  {
    nombre: "factura Transnec: el OCR leyó el ° como asterisco",
    texto: "TRANSNEC SPA RUT: 77.973.043-3 FACTURA ELECTRÓNICA N* 7960 Fecha Emisión 7 de septiembre de 2026",
    espera: { nro_documento: "7960", rut_proveedor: "77.973.043-3", tipo_documento: "Factura Electrónica" },
  },
  {
    nombre: "factura Correos: el ° salió como e, y se perdió la palabra FACTURA",
    // El SII rotula las exentas "FACTURA NO AFECTA O EXENTA ELECTRÓNICA" y
    // la foto se leyó "CURA EXENTA ELECTRÓNICA".
    texto: "RUT.: 60.503.000-9 CORREOSCHILE CURA EXENTA ELECTRÓNICA Ne 003191702 Monto Exento 6.840 Valor a Pagar 6.840",
    espera: { nro_documento: "003191702", tipo_documento: "Factura Exenta Electrónica", monto: 6840 },
  },
  {
    nombre: "la palabra 'no' no es un folio",
    // Con el flag "i", la clase N[°ºo] matchea "no": "Pago no 30 dias"
    // devolvía folio 30.
    texto: "FACTURA ELECTRONICA R.U.T. 96.505.760-9 Pago no 30 dias. Folio 136982 TOTAL $ 47.600",
    espera: { nro_documento: "136982" },
  },
  {
    nombre: "la orden de compra del encabezado no es el folio",
    texto: "Orden de compra No 4500123456 FACTURA ELECTRONICA N° 136982 R.U.T. 96.505.760-9 TOTAL $ 47.600",
    espera: { nro_documento: "136982" },
  },
  {
    nombre: "la resolución del SII no es el folio",
    texto: "FACTURA ELECTRONICA N° 136982 Res. Ex. N° 80 de 2014 R.U.T. 96.505.760-9 TOTAL $ 47.600",
    espera: { nro_documento: "136982" },
  },
  {
    nombre: "puros ceros no son un folio",
    // La foto de la factura de Correos devolvía "00000000", que es una
    // casilla vacía del formulario.
    texto: "BOLETA Ne 00000000 R.U.T. 96.505.760-9 TOTAL $ 8.990",
    espera: { nro_documento: null },
  },

  // ----------------------------------------------------------
  // RUT
  // ----------------------------------------------------------
  {
    nombre: "nuestro propio RUT aparece como receptor, no es el proveedor",
    texto: "FACTURA ELECTRONICA N° 1 R.U.T. 96.505.760-9 Señor(es) GRUPO WELLNESS SPA R.U.T. 77.574.911-3 TOTAL $ 47.600",
    espera: { rut_proveedor: "96.505.760-9" },
  },
  {
    nombre: "los dígitos de un RUT no son pesos",
    // 77.574.911-3 daba un "monto" de $77.574.911.
    texto: "FACTURA ELECTRONICA R.U.T. 96.505.760-9 Receptor 77.574.911-3 TOTAL $ 47.600",
    espera: { monto: 47600 },
  },

  // ----------------------------------------------------------
  // Tipos de documento que no son DTE
  // ----------------------------------------------------------
  {
    nombre: "comprobante de transferencia: ningún banco escribe ese título",
    // Texto real de la app de un banco. Se reconoce por Destinatario +
    // Cuenta Corriente, y el identificador es el código de transacción.
    texto: "Operación realizada Monto $230.000 Código de transacción 924735305337 De Cuenta Corriente N 148767101 Destinatario Dmoov spa Cuenta Corriente N 20200115458 - Banco Estado Motivo Pago LC Vencida Fecha 16 de septiembre de 2026",
    espera: { tipo_documento: "Comprobante de Transferencia", nro_documento: "924735305337", monto: 230000, nombre_proveedor: "Dmoov spa" },
  },
  {
    nombre: "voucher Transbank",
    texto: "TRANSBANK VOUCHER Comercio: COPEC ESTACION VITACURA Codigo de autorizacion 004512 TOTAL A PAGAR $ 25.400",
    espera: { tipo_documento: "Voucher", nombre_proveedor: "COPEC ESTACION VITACURA", monto: 25400 },
  },
  {
    nombre: "nota de crédito: NO es una factura",
    // Su bloque de referencias menciona una factura, así que /FACTURA
    // ELECTR/ matcheaba igual y la NC entraba con monto positivo a la
    // cuenta por pagar: el signo al revés.
    texto: "NOTA DE CREDITO ELECTRONICA N° 55 Referencia Factura Electronica N° 136982 R.U.T. 96.505.760-9 TOTAL $ 47.600",
    espera: { tipo_documento: "Nota de Crédito" },
  },
  {
    nombre: "nombre con ruido de OCR: no se inventa un proveedor",
    texto: "Destinatario: 4 Cuenta Corriente R.U.T. 96.505.760-9 TOTAL $ 8.990",
    espera: { nombre_proveedor: null },
  },

  // ----------------------------------------------------------
  // Descripción
  // ----------------------------------------------------------
  {
    nombre: "la descripción no arrastra columnas de la tabla",
    // Real (importadora FA DA 9). Tres causas a la vez: dos columnas de
    // cabecera sin limpiar, "Forma de Pago" que no cortaba, y un importe
    // con miles Y decimales ("1.819,33") que dos reglas se comían por
    // mitades y dejaban ",33" pegado.
    texto: "R.U.T. 77.864.123-2 FACTURA ELECTRONICA N°1251 Codigo Descripcion Cantidad Precio %Impto Adic.* %Desc. Valor - ARTICULOS VARIOS 20 1.819,33 36.387 Forma de Pago:Crédito MONTO NETO $ 36.387 I.V.A. 19% $ 6.914 TOTAL $ 43.301",
    espera: { descripcion: "ARTICULOS VARIOS", monto: 43301 },
  },
];

// Los orígenes de monto que se aceptan cuando la lectura vino de una FOTO.
// Tiene que coincidir con ORIGENES_ACEPTABLES_EN_FOTO de leerFotoLocal.
const ORIGENES_OK_FOTO = ["palabras+digitos", "aritmetica", "etiqueta"];

function correrPruebasLector() {
  const fallos = [];
  for (const caso of CASOS_LECTOR) {
    let obtenido;
    try {
      obtenido = parsearTextoFactura(caso.texto);
    } catch (err) {
      fallos.push({ caso: caso.nombre, error: String(err && err.message || err) });
      continue;
    }
    for (const [campo, esperado] of Object.entries(caso.espera)) {
      // "monto_en_foto" no es un campo del parser: es qué quedaría en el
      // formulario si esto hubiera venido de una foto.
      const real = campo === "monto_en_foto"
        ? (ORIGENES_OK_FOTO.includes(obtenido.monto_origen) ? obtenido.monto : null)
        : obtenido[campo];
      if (real !== esperado) fallos.push({ caso: caso.nombre, campo, esperaba: esperado, obtuvo: real });
    }
  }
  if (fallos.length) {
    console.error(`❌ ${fallos.length} fallo(s) en ${CASOS_LECTOR.length} casos:`);
    console.table(fallos);
  } else {
    console.log(`✅ ${CASOS_LECTOR.length} casos del lector, todos correctos.`);
  }
  return { total: CASOS_LECTOR.length, fallos };
}

if (typeof window !== "undefined") {
  window.CASOS_LECTOR = CASOS_LECTOR;
  window.correrPruebasLector = correrPruebasLector;
}
