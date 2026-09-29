#!/usr/bin/env python3
"""
sncdata_reader.py — Leitor de banco Firebird/InterBase ODS 10.x (ex.: Sncdata.fdb do
Sun Nuclear Daily QA 3 / Atlas) sem servidor Firebird, lendo as páginas diretamente.

Motivo: Firebird >= 2.5 não abre ODS 10 ("unsupported on-disk structure ... found 10.1").

Uso:
    python sncdata_reader.py Sncdata.fdb --list                 # tabelas e nº de registros
    python sncdata_reader.py Sncdata.fdb --csv  saida_csv/      # exporta todas as tabelas em CSV
    python sncdata_reader.py Sncdata.fdb --sqlite saida.db      # exporta para SQLite
    python sncdata_reader.py Sncdata.fdb --usage colunas.xlsx [--dias 365]
                                                                # colunas em uso (janela recente)

Premissas do formato (verificadas neste arquivo; ajuste se usar outro banco):
  * Página: header de 16 bytes; tamanho lido do header page (offset 0x10).
  * Data page (tipo 5): dpg_sequence @16 (u32), dpg_relation @20 (u16), dpg_count @22 (u16),
    vetor de slots {offset u16, length u16} a partir de @24.
  * Registro: rhd_transaction u32, b_page u32, b_line u16, flags u16, format u8 → dados @13.
    Registro fragmentado (rhd_incomplete): f_page u32 @16, f_line u16 @20 → dados @22.
  * Compressão RLE: byte de controle com sinal; >0 copia n bytes, <0 repete o próximo byte -n vezes.
  * Nº de registro = dpg_sequence * MAXREC + linha, MAXREC = (page_size-28) // 17  (239 p/ 4 kB).
  * Blob: header de 28 bytes (level @12, length @20); nível 0 = dados no próprio slot,
    nível 1 = lista de páginas de blob (tipo 8, dados @28, comprimento u16 @24).
  * Descritores de formato (RDB$FORMATS.RDB$DESCRIPTOR): structs dsc de 12 bytes
    (dtype u8, scale s8, length u16, sub_type s16, flags u16, offset u32).
  * Offsets fixos das tabelas de sistema (ODS 10):
      RDB$RELATIONS (id 6): RELATION_ID @28, FORMAT @34, RELATION_NAME char(31) @38
      RDB$FORMATS  (id 8): RELATION_ID @4, FORMAT @6, DESCRIPTOR (blob id) @8
      RDB$RELATION_FIELDS (id 5): FIELD_NAME @4, RELATION_NAME @35, FIELD_POSITION @288, FIELD_ID @302
  * Bit i do null bitmap (início do registro) = 1 → campo i é NULL.
Somente leitura: o arquivo original nunca é alterado.
"""
import argparse, collections, csv, datetime, os, sqlite3, struct, sys

DTYPES = {1: 'CHAR', 3: 'VARCHAR', 7: 'BYTE', 8: 'SMALLINT', 9: 'INTEGER', 11: 'FLOAT',
          12: 'DOUBLE', 14: 'DATE', 15: 'TIME', 16: 'TIMESTAMP', 17: 'BLOB', 19: 'BIGINT'}
EPOCH = datetime.date(1858, 11, 17)          # época das datas InterBase/Firebird

# flags do cabeçalho de registro
RHD_DELETED, RHD_CHAIN, RHD_FRAGMENT, RHD_INCOMPLETE, RHD_BLOB = 1, 2, 4, 8, 16


class FDB:
    def __init__(self, path):
        with open(path, 'rb') as f:
            self.data = f.read()
        self.ps = struct.unpack_from('<H', self.data, 0x10)[0]
        ods = struct.unpack_from('<H', self.data, 0x12)[0] & 0x7FFF
        if ods != 10:
            print(f'Aviso: ODS {ods}; o parser foi feito para ODS 10.', file=sys.stderr)
        self.npages = len(self.data) // self.ps
        self.maxrec = (self.ps - 28) // 17
        self.pagemap = {}                    # (relation, sequence) -> nº da página
        self.dp = collections.defaultdict(list)
        for i in range(self.npages):
            p = self.page(i)
            if p[0] == 5:
                seq, rel = struct.unpack_from('<IH', p, 16)
                self.pagemap[(rel, seq)] = i
                self.dp[rel].append((seq, i))
        self._load_catalog()

    # ---------- nível de página ----------
    def page(self, n):
        return self.data[n * self.ps:(n + 1) * self.ps]

    def slot(self, pno, line):
        p = self.page(pno)
        if line >= struct.unpack_from('<H', p, 22)[0]:
            return None
        off, ln = struct.unpack_from('<HH', p, 24 + 4 * line)
        return p[off:off + ln] if off and ln else None

    def slots(self, pno):
        p = self.page(pno)
        for line in range(struct.unpack_from('<H', p, 22)[0]):
            r = self.slot(pno, line)
            if r:
                yield line, r

    @staticmethod
    def decompress(b):
        out, i = bytearray(), 0
        while i < len(b):
            c = struct.unpack_from('b', b, i)[0]; i += 1
            if c > 0:
                out += b[i:i + c]; i += c
            elif c < 0:
                out += bytes([b[i]]) * (-c); i += 1
        return bytes(out)

    # ---------- registros ----------
    def records(self, rel):
        """Gera (recno, transação, formato, bytes descomprimidos) das versões primárias."""
        for seq, pno in sorted(self.dp.get(rel, [])):
            for line, r in self.slots(pno):
                tr, _, _, fl, fmt = struct.unpack_from('<IIHHB', r, 0)
                if fl & (RHD_DELETED | RHD_CHAIN | RHD_FRAGMENT | RHD_BLOB):
                    continue
                if fl & RHD_INCOMPLETE:
                    chunks, cur = [r[22:]], r
                    while True:
                        fpage, fline = struct.unpack_from('<IH', cur, 16)
                        cur = self.slot(fpage, fline)
                        if struct.unpack_from('<H', cur, 10)[0] & RHD_INCOMPLETE:
                            chunks.append(cur[22:])
                        else:
                            chunks.append(cur[13:]); break
                    d = self.decompress(b''.join(chunks))
                else:
                    d = self.decompress(r[13:])
                yield seq * self.maxrec + line, tr, fmt, d

    def blob(self, rel, recno):
        """Retorna o conteúdo de um blob (segmentos concatenados)."""
        seq, line = divmod(recno, self.maxrec)
        pno = self.pagemap.get((rel, seq))
        r = self.slot(pno, line) if pno is not None else None
        if r is None:
            return None
        level, length = r[12], struct.unpack_from('<I', r, 20)[0]
        body = r[28:]
        if level == 1:
            pages = struct.unpack_from('<%dI' % (len(body) // 4), body)
            parts = []
            for pn in pages:
                bp = self.page(pn)
                parts.append(bp[28:28 + struct.unpack_from('<H', bp, 24)[0]])
            body = b''.join(parts)
        elif level > 1:
            raise NotImplementedError('blob de nível 2')
        # blob segmentado: [u16 tamanho][dados]...
        out, i = bytearray(), 0
        while i + 2 <= len(body) and len(out) < length:
            n = struct.unpack_from('<H', body, i)[0]
            out += body[i + 2:i + 2 + n]; i += 2 + n
        return bytes(out)

    # ---------- catálogo ----------
    def _load_catalog(self):
        self.names, self.curfmt = {}, {}
        for _, _, _, d in self.records(6):                        # RDB$RELATIONS
            rid, fmt = struct.unpack_from('<h', d, 28)[0], struct.unpack_from('<h', d, 34)[0]
            self.names[rid] = d[38:69].decode('latin1').strip()
            self.curfmt[rid] = fmt
        self.formats = {}
        for _, _, _, d in self.records(8):                        # RDB$FORMATS
            rid, fno = struct.unpack_from('<hh', d, 4)
            brel, bno = struct.unpack_from('<II', d, 8)
            raw = self.blob(brel, bno)
            if raw:
                self.formats[(rid, fno)] = [struct.unpack_from('<BbHhHI', raw, i)
                                            for i in range(0, len(raw) // 12 * 12, 12)]
        self.fields = collections.defaultdict(dict)               # tabela -> {field_id: (pos, nome)}
        for _, _, _, d in self.records(5):                        # RDB$RELATION_FIELDS
            fn = d[4:35].decode('latin1').strip()
            rn = d[35:66].decode('latin1').strip()
            pos, fid = struct.unpack_from('<h', d, 288)[0], struct.unpack_from('<h', d, 302)[0]
            self.fields[rn][fid] = (pos, fn)

    def user_tables(self):
        return {rid: n for rid, n in sorted(self.names.items()) if rid >= 128}

    def rel_id(self, table):
        return next(r for r, n in self.names.items() if n == table)

    def columns(self, table):
        fm = self.fields[table]
        return [fm[k][1] for k in sorted(fm, key=lambda k: fm[k][0])]

    def column_meta(self, table):
        """nome -> (relation_id, posição, field_id, tipo, offset) no formato corrente."""
        rid = self.rel_id(table)
        descs = self.formats[(rid, self.curfmt[rid])]
        out = {}
        for fid, (pos, fn) in self.fields[table].items():
            dt, sc, ln, _, _, off = descs[fid]
            t = DTYPES.get(dt, str(dt))
            if dt in (1, 3):
                t += f'({ln - (2 if dt == 3 else 0)})'
            if dt in (8, 9, 19) and sc:
                t = f'NUMERIC({t}, scale {sc})'
            out[fn] = (rid, pos, fid, t, off)
        return out

    # ---------- valores ----------
    @staticmethod
    def value(d, desc):
        dt, sc, ln, _, _, off = desc
        b = d[off:off + ln].ljust(ln, b'\0')     # RLE pode omitir zeros finais
        if dt == 1:  return b.decode('latin1').rstrip()
        if dt == 3:  return b[2:2 + struct.unpack_from('<H', b)[0]].decode('latin1')
        if dt == 7:  return b[0]
        if dt in (8, 9, 19):
            v = struct.unpack('<' + {8: 'h', 9: 'i', 19: 'q'}[dt], b)[0]
            return v * 10 ** sc if sc else v
        if dt == 11: return struct.unpack('<f', b)[0]
        if dt == 12: return struct.unpack('<d', b)[0]
        if dt == 14: return (EPOCH + datetime.timedelta(days=struct.unpack('<i', b)[0])).isoformat()
        if dt == 15: return str(datetime.timedelta(seconds=struct.unpack('<I', b)[0] / 10000))
        if dt == 16:
            days, t = struct.unpack('<iI', b)
            ts = datetime.datetime.combine(EPOCH, datetime.time()) + \
                 datetime.timedelta(days=days, seconds=t / 10000)
            return ts.isoformat(sep=' ')
        if dt == 17: return 'BLOB(%d,%d)' % struct.unpack('<II', b)
        return None

    def rows(self, table):
        rid = self.rel_id(table)
        fm = self.fields[table]
        for _, _, fmt, d in self.records(rid):
            descs = self.formats.get((rid, fmt))
            if descs is None:
                continue
            row = {}
            for fid, (_, fn) in fm.items():
                if fid >= len(descs) or descs[fid][0] == 0:
                    row[fn] = None; continue
                is_null = (d[fid // 8] >> (fid % 8)) & 1 if fid // 8 < len(d) else 1
                row[fn] = None if is_null else self.value(d, descs[fid])
            yield row


# ================= análise de colunas em uso =================
def usage(db, dias):
    T = {n: list(db.rows(n)) for n in db.user_tables().values()}
    ultimo = max(x['DATETIME'] for x in T['DQA3_DATA'] if x['DATETIME'])
    lo = (datetime.datetime.fromisoformat(ultimo) - datetime.timedelta(days=dias)).isoformat(sep=' ')
    data = [x for x in T['DQA3_DATA'] if x['DATETIME'] and x['DATETIME'] >= lo]
    trend = [x for x in T['DQA3_TREND'] if x['DATETIME'] and x['DATETIME'] >= lo]
    k = {c: {x[c] for x in data} for c in
         ('SET_KEY', 'CAL_KEY', 'DEVICE_KEY', 'FIRMWARE_KEY', 'CLIENT_VERSION_KEY')}
    maq = {x['MACH_KEY'] for x in T['DQA3_TEMPLATE'] if x['SET_KEY'] in k['SET_KEY']}
    salas = {x['ROOM_KEY'] for x in T['DQA3_MACHINE'] if x['MACH_KEY'] in maq}
    inst = {x['INST_KEY'] for x in T['ROOM'] if x['ROOM_KEY'] in salas}
    f = lambda t, p: [x for x in T[t] if p(x)]
    sel = {
        'DQA3_DATA': data, 'DQA3_TREND': trend,
        'DQA3_TEMPLATE': f('DQA3_TEMPLATE', lambda x: x['SET_KEY'] in k['SET_KEY']),
        'DQA3_CALIBRATION': f('DQA3_CALIBRATION', lambda x: x['CAL_KEY'] in k['CAL_KEY']),
        'DQA3_ENERGY_CALIBRATION': f('DQA3_ENERGY_CALIBRATION',
                                     lambda x: x['MACH_KEY'] in maq and x['CURRENT_CAL'] == 'Y'),
        'DQA3_MACHINE': f('DQA3_MACHINE', lambda x: x['MACH_KEY'] in maq),
        'ROOM': f('ROOM', lambda x: x['ROOM_KEY'] in salas),
        'INSTITUTION': f('INSTITUTION', lambda x: x['INST_KEY'] in inst),
        'DEVICE': f('DEVICE', lambda x: x['DEVICE_KEY'] in k['DEVICE_KEY']),
        'DEVICE_FIRMWARE': f('DEVICE_FIRMWARE', lambda x: x['FIRMWARE_KEY'] in k['FIRMWARE_KEY']),
        'CLIENT_SOFTWARE': f('CLIENT_SOFTWARE',
                             lambda x: x['CLIENT_VERSION_KEY'] in k['CLIENT_VERSION_KEY']),
        'USERS': T['USERS'],
    }
    res = []
    for tab, rows in sel.items():
        meta = db.column_meta(tab)
        for fn in db.columns(tab):
            vals = [x.get(fn) for x in rows]
            nn = [v for v in vals if v is not None]
            nz = [v for v in nn if v not in (0, 0.0) and not (isinstance(v, str) and not v.strip())]
            if not nn:   st = 'NULO'
            elif not nz: st = 'ZERO/VAZIO'
            elif len(set(map(str, nz))) == 1: st = 'EM USO – constante'
            else:        st = 'EM USO – variável'
            ex = nz[-1] if nz else (nn[-1] if nn else None)
            res.append([tab, *meta[fn], fn, st, len(nz), len(rows), '' if ex is None else str(ex)])
    return res, lo, ultimo


def write_usage_xlsx(res, path, lo, hi):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    hdr = ['Tabela', 'RDB$RELATION_ID', 'Posição', 'RDB$FIELD_ID', 'Tipo', 'Offset (bytes)',
           'Coluna', 'Status', 'Registros preenchidos', 'Registros avaliados', 'Último valor']
    wb = Workbook(); ws1 = wb.active; ws1.title = 'Colunas em uso'
    ws2 = wb.create_sheet('Colunas sem uso')
    for ws, cond in ((ws1, True), (ws2, False)):
        ws.append(hdr)
        for r in sorted(res, key=lambda r: (r[0], r[2])):
            if r[7].startswith('EM USO') == cond:
                ws.append(r)
        for c in ws[1]:
            c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='1F4E78')
        ws.freeze_panes = 'A2'; ws.auto_filter.ref = ws.dimensions
    wb.create_sheet('Critérios').append([f'Janela avaliada: {lo} a {hi}'])
    wb.save(path)


# ================= CLI =================
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('fdb')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--csv', metavar='PASTA')
    ap.add_argument('--sqlite', metavar='ARQUIVO')
    ap.add_argument('--usage', metavar='XLSX')
    ap.add_argument('--dias', type=int, default=365)
    a = ap.parse_args()
    db = FDB(a.fdb)

    if a.list or not (a.csv or a.sqlite or a.usage):
        for rid, n in db.user_tables().items():
            print(f'{rid:4d}  {n:28s} {len(db.columns(n)):4d} colunas  {sum(1 for _ in db.rows(n)):7d} registros')

    if a.csv:
        os.makedirs(a.csv, exist_ok=True)
        for n in db.user_tables().values():
            with open(os.path.join(a.csv, n + '.csv'), 'w', newline='', encoding='utf-8-sig') as fh:
                w = csv.DictWriter(fh, fieldnames=db.columns(n), delimiter=';')
                w.writeheader(); w.writerows(db.rows(n))
        print('CSV exportados em', a.csv)

    if a.sqlite:
        con = sqlite3.connect(a.sqlite)
        for n in db.user_tables().values():
            cols = db.columns(n)
            con.execute(f'DROP TABLE IF EXISTS "{n}"')
            con.execute(f'CREATE TABLE "{n}" (' + ','.join(f'"{c}"' for c in cols) + ')')
            con.executemany(f'INSERT INTO "{n}" VALUES (' + ','.join('?' * len(cols)) + ')',
                            ([r[c] for c in cols] for r in db.rows(n)))
        con.commit(); con.close()
        print('SQLite gravado em', a.sqlite)

    if a.usage:
        res, lo, hi = usage(db, a.dias)
        write_usage_xlsx(res, a.usage, lo, hi)
        n_uso = sum(r[7].startswith('EM USO') for r in res)
        print(f'Janela {lo} → {hi}: {n_uso} colunas em uso, {len(res) - n_uso} sem uso → {a.usage}')


if __name__ == '__main__':
    main()
