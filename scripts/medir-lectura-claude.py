"""Mide cuánto acierta cada lector de comprobantes contra el corpus de Rindegastos.

El corpus son los informes PDF del sistema anterior: cada gasto trae una página
con los datos correctos (RUT, folio, tipo, fecha, monto) y otra con la foto del
comprobante. Se manda SOLO la foto, con las mismas instrucciones que usa hoy la
app (se leen de supabase/functions/_shared/gemini-ocr.ts), y se compara la
respuesta con los datos correctos.

Uso (desde la raíz del repo):
  py -3 -E -P scripts/medir-lectura-claude.py --solo-preparar      # sin IA, sin costo
  py -3 -E -P scripts/medir-lectura-claude.py                      # Claude Haiku, Sonnet y Opus
  py -3 -E -P scripts/medir-lectura-claude.py --con-gemini --con-groq   # + los actuales
(-E -P y no -I: -I oculta los paquetes instalados con pip --user, como anthropic.)

Claves: ANTHROPIC_API_KEY (o `ant auth login`), GEMINI_API_KEY, GROQ_API_KEY,
como variables de entorno de la terminal. El script nunca las escribe en disco.
Las fotos y resultados quedan en --salida, FUERA del repo (son documentos reales).
Se puede cortar y volver a correr: lo ya leído no se vuelve a pagar.
"""
import argparse, base64, collections, concurrent.futures as cf, glob, io, json, os, random, re, sys, time, unicodedata, urllib.request, urllib.error

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = r"G:\Mi unidad\1.-Data_GW\Rindegastos\Rendiciones_PDF"
SALIDA = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "RindeWellness", "medicion-ocr")
# US$ por millón de tokens (entrada, salida), precios publicados al 2026-11-03.
PRECIOS = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.00, 10.00), "claude-opus-5-5": (4.00, 20.00)}
CAMPOS = ["rut_proveedor", "nro_documento", "fecha", "monto", "tipo_documento", "nombre_proveedor"]
CLAVE = ["rut_proveedor", "nro_documento", "fecha", "monto"]  # los que van a contabilidad


# ---------- instrucciones: las mismas de producción ----------
def prompt_produccion():
    ts = open(os.path.join(RAIZ, "supabase", "functions", "_shared", "gemini-ocr.ts"), encoding="utf-8").read()
    cats = json.loads("[" + re.search(r"export const CATEGORIAS = \[(.*?)\];", ts, re.S).group(1).strip().rstrip(",") + "]")
    texto = re.search(r"const PROMPT = `(.*?)`;", ts, re.S).group(1)
    reemplazo = ", ".join(f'"{c}"' for c in cats)
    texto, n = re.subn(r"\$\{CATEGORIAS\.map\(\(c\) => `\"\$\{c\}\"`\)\.join\(\", \"\)\}", lambda _: reemplazo, texto)
    if n != 1 or "${" in texto:
        sys.exit("No pude reconstruir el prompt de gemini-ocr.ts; revisa si cambió su forma.")
    return texto


# ---------- corpus ----------
def campo(texto, etiqueta):
    m = re.search(r"(?:^|\n)" + re.escape(etiqueta) + r"\n([^\n]*)", texto)
    return m.group(1).strip() if m else None

def adicional(texto, nombre):
    m = re.search(re.escape(nombre) + r":\s*([^|\n]+)", texto)
    return m.group(1).strip() if m else None

def leer_corpus(carpeta):
    import pymupdf
    gastos = []
    for ruta in sorted(glob.glob(os.path.join(carpeta, "**", "*.pdf"), recursive=True)):
        try:
            doc = pymupdf.open(ruta)
        except Exception as e:
            print("  no se pudo abrir", os.path.basename(ruta), e); continue
        paginas = list(doc)
        for i, pg in enumerate(paginas):
            t = pg.get_text()
            if not t.startswith("Gasto "):
                continue
            imagenes = [im[0] for p in paginas[i:i + 2] for im in p.get_images()]
            if not imagenes:
                continue
            total = campo(t, "Total") or ""
            m = re.search(r"([\d.]+)\s*CLP", total)
            gastos.append({
                "id": f"{os.path.basename(os.path.dirname(ruta))}|{os.path.basename(ruta)}|{t.splitlines()[0]}",
                "pdf": ruta, "xref": imagenes[0], "persona": os.path.basename(os.path.dirname(ruta)),
                "referencia": {
                    "nombre_proveedor": campo(t, "Proveedor"),
                    "rut_proveedor": adicional(t, "RUT Proveedor"),
                    "nro_documento": adicional(t, "Número de Documento"),
                    "tipo_documento": adicional(t, "Tipo de Documento"),
                    "fecha": campo(t, "Fecha"),
                    "monto": int(m.group(1).replace(".", "")) if m else None,
                }})
    return gastos

def muestrear(gastos, n, semilla):
    """Un gasto por informe y repartido entre personas y tipos de documento."""
    rnd = random.Random(semilla)
    por_pdf = collections.defaultdict(list)
    for g in gastos:
        por_pdf[g["pdf"]].append(g)
    candidatos = [rnd.choice(v) for v in por_pdf.values()]
    grupos = collections.defaultdict(list)
    for g in candidatos:
        grupos[(familia(g["referencia"]["tipo_documento"]), g["persona"])].append(g)
    for v in grupos.values():
        rnd.shuffle(v)
    claves = list(grupos); rnd.shuffle(claves)
    elegidos = []
    while len(elegidos) < n and any(grupos.values()):
        for k in claves:
            if grupos[k] and len(elegidos) < n:
                elegidos.append(grupos[k].pop())
    return elegidos

def imagen(g, carpeta_fotos):
    """JPEG del comprobante, achicado si es enorme (mismo archivo para todos los lectores)."""
    destino = os.path.join(carpeta_fotos, re.sub(r"[^\w.-]+", "_", g["id"])[:150] + ".jpg")
    if not os.path.exists(destino):
        import pymupdf
        from PIL import Image
        datos = pymupdf.open(g["pdf"]).extract_image(g["xref"])["image"]
        foto = Image.open(io.BytesIO(datos)).convert("RGB")
        if max(foto.size) > 2000:
            foto.thumbnail((2000, 2000))
        foto.save(destino, "JPEG", quality=88)
    return base64.b64encode(open(destino, "rb").read()).decode()


# ---------- lectores ----------
def extraer_json(texto):
    a, b = texto.find("{"), texto.rfind("}")
    return json.loads(texto[a:b + 1]) if a >= 0 and b > a else None

def leer_claude(cliente, modelo, foto, prompt, esfuerzo):
    import anthropic
    t0 = time.time()
    try:
        r = cliente.messages.create(
            model=modelo, max_tokens=8000, output_config={"effort": esfuerzo},
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": foto}},
                {"type": "text", "text": prompt}]}])
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
        return {"error": f"credencial rechazada (HTTP {e.status_code})", "abortar": True}
    except anthropic.RateLimitError as e:
        return {"error": "limite: " + str(e)[:200], "reintentar": True}
    except anthropic.APIStatusError as e:
        return {"error": f"HTTP {e.status_code}: {str(e)[:200]}", "reintentar": e.status_code >= 500}
    except anthropic.APIConnectionError as e:
        return {"error": "conexion: " + str(e)[:200], "reintentar": True}
    entrada, salida = r.usage.input_tokens, r.usage.output_tokens
    pin, pout = PRECIOS[modelo]
    base = {"segundos": round(time.time() - t0, 1), "tokens_entrada": entrada, "tokens_salida": salida,
            "costo_usd": entrada * pin / 1e6 + salida * pout / 1e6, "stop_reason": r.stop_reason}
    if r.stop_reason == "refusal":
        return {**base, "error": "rechazada"}
    texto = "".join(b.text for b in r.content if b.type == "text")
    try:
        return {**base, "datos": extraer_json(texto)}
    except ValueError:
        return {**base, "error": "JSON inválido", "texto": texto[:500]}

def post_json(url, cuerpo, cabeceras):
    pedido = urllib.request.Request(url, data=json.dumps(cuerpo).encode(), headers={"Content-Type": "application/json", **cabeceras})
    with urllib.request.urlopen(pedido, timeout=120) as r:
        return json.loads(r.read())

def leer_gemini(modelo, foto, prompt):
    t0 = time.time()
    try:
        r = post_json(f"https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent",
                      {"contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": "image/jpeg", "data": foto}}]}],
                       "generationConfig": {"responseMimeType": "application/json", "temperature": 0}},
                      {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        texto = r["candidates"][0]["content"]["parts"][0]["text"]
        return {"segundos": round(time.time() - t0, 1), "costo_usd": 0.0, "datos": extraer_json(texto)}
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "cupo_agotado": e.code == 429}
    except Exception as e:
        return {"error": str(e)[:200]}

def leer_groq(foto, prompt):
    t0 = time.time()
    try:
        r = post_json("https://api.groq.com/openai/v1/chat/completions",
                      {"model": "qwen/qwen3.8-27b", "temperature": 0, "max_completion_tokens": 2048, "response_format": {"type": "json_object"},
                       "messages": [{"role": "user", "content": [{"type": "text", "text": prompt},
                                                                  {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + foto}}]}]},
                      {"Authorization": "Bearer " + os.environ["GROQ_API_KEY"]})
        return {"segundos": round(time.time() - t0, 1), "costo_usd": 0.0, "datos": extraer_json(r["choices"][0]["message"]["content"])}
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}", "cupo_agotado": e.code == 429}
    except Exception as e:
        return {"error": str(e)[:200]}


# ---------- evaluación (mismo criterio que scripts/evaluar-ocr.cjs) ----------
def familia(tipo):
    t = sin_tildes(tipo or "")
    if not t: return None
    if "honorario" in t: return "honorarios"
    if "factura" in t: return "factura exenta" if "exenta" in t else "factura"
    if "boleta" in t: return "boleta"
    return "otro"

def sin_tildes(v):
    return unicodedata.normalize("NFD", str(v)).encode("ascii", "ignore").decode().strip().lower()

def normalizar(campo_, valor):
    if valor is None or valor == "": return None
    if campo_ == "monto":
        try: return int(round(float(str(valor).replace(".", "").replace(",", ".")))) if isinstance(valor, str) else int(round(float(valor)))
        except ValueError: return str(valor)
    if campo_ == "rut_proveedor": return re.sub(r"[^0-9kK]", "", str(valor)).upper() or None
    if campo_ == "nro_documento": return re.sub(r"^0+(?=\d)", "", str(valor).strip()) or None
    if campo_ == "tipo_documento": return familia(valor)
    return re.sub(r"\s+", " ", sin_tildes(valor))

def evaluar(muestra, lecturas):
    filas = {}
    for lector, por_id in lecturas.items():
        p = {c: collections.Counter() for c in CAMPOS}
        docs_ok = leidos = fallos = 0; costo = segundos = 0.0
        for g in muestra:
            r = por_id.get(g["id"])
            if not r: continue
            costo += r.get("costo_usd", 0); segundos += r.get("segundos", 0)
            if r.get("error") or not isinstance(r.get("datos"), dict):
                fallos += 1; continue
            leidos += 1; todo_bien = True
            for c in CAMPOS:
                esperado, visto = normalizar(c, g["referencia"].get(c)), normalizar(c, r["datos"].get(c))
                if esperado is None: continue
                p[c]["con_referencia"] += 1
                if visto is None: p[c]["vacios"] += 1
                elif visto == esperado: p[c]["correctos"] += 1
                else: p[c]["equivocados"] += 1
                if c in CLAVE and visto != esperado: todo_bien = False
            docs_ok += todo_bien
        filas[lector] = {"leidos": leidos, "fallidos": fallos, "docs_4_campos_ok": docs_ok, "costo_usd": round(costo, 4),
                         "costo_por_lectura_usd": round(costo / max(1, leidos + fallos), 5),
                         "segundos_promedio": round(segundos / max(1, leidos + fallos), 1), "campos": {c: dict(v) for c, v in p.items()}}
    return filas

def informe_md(resultado, n):
    l = [f"# Medición de lectores de comprobantes ({n} fotos del corpus de Rindegastos)", "",
         "Equivocado = el lector puso un valor distinto al correcto (lo peor: entra mal a contabilidad). Vacío = no lo leyó (la persona lo escribe).", "",
         "| Lector | Leídas | Fallidas | 4 campos clave OK | Costo total US$ | Costo por foto US$ | Seg. prom. |", "|---|---|---|---|---|---|---|"]
    for k, v in resultado.items():
        l.append(f"| {k} | {v['leidos']} | {v['fallidos']} | {v['docs_4_campos_ok']} | {v['costo_usd']} | {v['costo_por_lectura_usd']} | {v['segundos_promedio']} |")
    for c in CAMPOS:
        l += ["", f"## {c}", "", "| Lector | Correctos | Equivocados | Vacíos | Con referencia |", "|---|---|---|---|---|"]
        for k, v in resultado.items():
            x = v["campos"][c]
            l.append(f"| {k} | {x.get('correctos', 0)} | {x.get('equivocados', 0)} | {x.get('vacios', 0)} | {x.get('con_referencia', 0)} |")
    return "\n".join(l) + "\n"


# ---------- principal ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=CORPUS)
    ap.add_argument("--salida", default=SALIDA)
    ap.add_argument("--muestra", type=int, default=40)
    ap.add_argument("--semilla", type=int, default=7)
    ap.add_argument("--modelos", default="claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5")
    ap.add_argument("--esfuerzo", default="medium", choices=["low", "medium", "high"])
    ap.add_argument("--con-gemini", action="store_true")
    ap.add_argument("--gemini-modelo", default="gemini-3.5-flash-lite")
    ap.add_argument("--con-groq", action="store_true")
    ap.add_argument("--solo-preparar", action="store_true", help="arma la muestra y las fotos, sin llamar a ninguna IA")
    a = ap.parse_args()

    if os.path.commonpath([os.path.abspath(a.salida), RAIZ]) == RAIZ:
        sys.exit("--salida debe quedar fuera del repo: son comprobantes reales.")
    fotos = os.path.join(a.salida, "fotos"); os.makedirs(fotos, exist_ok=True)
    prompt = prompt_produccion()

    ruta_muestra = os.path.join(a.salida, f"muestra_{a.muestra}_{a.semilla}.json")
    if os.path.exists(ruta_muestra):
        muestra = json.load(open(ruta_muestra, encoding="utf-8"))
    else:
        print("Leyendo el corpus…")
        muestra = muestrear(leer_corpus(a.corpus), a.muestra, a.semilla)
        json.dump(muestra, open(ruta_muestra, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for g in muestra:
        imagen(g, fotos)
    tipos = collections.Counter(familia(g["referencia"]["tipo_documento"]) for g in muestra)
    print(f"Muestra: {len(muestra)} fotos de {len({g['persona'] for g in muestra})} personas · {dict(tipos)}")
    print(f"Fotos en {fotos}")
    modelos = [m for m in a.modelos.split(",") if m]
    if a.solo_preparar:
        print(f"Estimado: ~{len(muestra) * len(modelos)} lecturas de Claude. A ~4.000 tokens de entrada y ~1.500 de salida",
              "(instrucciones + foto + razonamiento), el costo sería del orden de US$",
              round(sum(len(muestra) * (4000 * PRECIOS[m][0] + 1500 * PRECIOS[m][1]) / 1e6 for m in modelos), 2))
        return

    ruta_lecturas = os.path.join(a.salida, "lecturas.jsonl")
    lecturas = collections.defaultdict(dict)
    if os.path.exists(ruta_lecturas):
        for linea in open(ruta_lecturas, encoding="utf-8"):
            x = json.loads(linea)
            if not x["resultado"].get("reintentar"):
                lecturas[x["lector"]][x["id"]] = x["resultado"]
    salida = open(ruta_lecturas, "a", encoding="utf-8")
    def guardar(lector, g, r):
        lecturas[lector][g["id"]] = r
        salida.write(json.dumps({"lector": lector, "id": g["id"], "resultado": r}, ensure_ascii=False) + "\n"); salida.flush()

    if modelos:
        import anthropic
        # Verificación previa sin costo: credencial válida y nombres de modelo existentes.
        try:
            cliente = anthropic.Anthropic()
            for m in modelos:
                cliente.models.retrieve(m)
        except anthropic.NotFoundError as e:
            sys.exit(f"Un modelo no existe para esta cuenta: {e}")
        except Exception as e:
            sys.exit(f"No hay credencial de Claude válida ({str(e)[:160]}). Define ANTHROPIC_API_KEY en esta terminal o usa `ant auth login`.")
        pendientes = [(m, g) for m in modelos for g in muestra if g["id"] not in lecturas[m]]
        print(f"Claude: {len(pendientes)} lecturas pendientes…")
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            futuros = {pool.submit(leer_claude, cliente, m, imagen(g, fotos), prompt, a.esfuerzo): (m, g) for m, g in pendientes}
            for i, f in enumerate(cf.as_completed(futuros), 1):
                m, g = futuros[f]; r = f.result()
                if r.get("abortar"):
                    for x in futuros: x.cancel()
                    sys.exit(f"Claude rechazó la credencial ({r['error']}). Revisa ANTHROPIC_API_KEY o `ant auth login`; no se anotó nada.")
                guardar(m, g, r)
                print(f"  [{i}/{len(pendientes)}] {m}: {'error ' + r['error'] if r.get('error') else 'ok'} {r.get('segundos', '')}s")
    for activo, lector, leer, pausa in ((a.con_gemini, "gemini:" + a.gemini_modelo, lambda f: leer_gemini(a.gemini_modelo, f, prompt), 5),
                                        (a.con_groq, "groq:qwen3.8-27b", lambda f: leer_groq(f, prompt), 10)):
        if not activo: continue
        for g in muestra:
            if g["id"] in lecturas[lector]: continue
            r = leer(imagen(g, fotos))
            if r.get("cupo_agotado"):
                print(f"  {lector}: cupo gratuito agotado; vuelve a correr más tarde para seguir."); break
            guardar(lector, g, r); print(f"  {lector}: {'error ' + r['error'] if r.get('error') else 'ok'}")
            time.sleep(pausa)
    salida.close()

    resultado = evaluar(muestra, lecturas)
    json.dump(resultado, open(os.path.join(a.salida, "resultado.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    # Los datos "correctos" los tipeó una persona en el sistema anterior y a veces
    # están mal: cada diferencia queda listada para revisarla mirando la foto.
    import csv
    with open(os.path.join(a.salida, "diferencias.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["foto", "lector", "campo", "dato correcto", "leido"])
        for g in muestra:
            for lector, por_id in lecturas.items():
                d = (por_id.get(g["id"]) or {}).get("datos")
                if not isinstance(d, dict): continue
                for c in CLAVE:
                    e, v = normalizar(c, g["referencia"].get(c)), normalizar(c, d.get(c))
                    if e is not None and v is not None and e != v:
                        w.writerow([re.sub(r"[^\w.-]+", "_", g["id"])[:150] + ".jpg", lector, c, g["referencia"].get(c), d.get(c)])
    md = informe_md(resultado, len(muestra))
    open(os.path.join(a.salida, "resultado.md"), "w", encoding="utf-8").write(md)
    print("\n" + md + f"\nGuardado en {a.salida}")

if __name__ == "__main__":
    main()
