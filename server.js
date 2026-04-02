const express = require('express');
const Firebird = require('node-firebird');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_OPTIONS = {
  host: 'localhost', port: 3050,
  database: 'aecdb',
  user: 'SYSDBA', password: 'masterkey',
  lowercase_keys: true, charset: 'WIN1252'
};

const DATA_FILE = path.join(__dirname, 'cashflow_data.json');

function defaultSaldiBanche() {
  return {
    aggiornato_il: null,
    banche: [
      { id: 'bpm_20496', nome: 'Banco BPM', conto: 'C/C 20496',              iban: 'IT34S0503420504000000020496', bic: 'BAPPIT21810',   valuta: 'EUR', saldo: 0 },
      { id: 'bpm_36062', nome: 'Banco BPM', conto: 'C/C 36062 Fotovoltaico', iban: 'IT34S0503420504000000036062', bic: 'BAPPIT21810',   valuta: 'EUR', saldo: 0 },
      { id: 'bdm',       nome: 'BDM',        conto: 'C/C Principale',          iban: 'IT58B0542401601000001200206', bic: 'BPBAIT3BXXX',  valuta: 'EUR', saldo: 0 },
      { id: 'wise_eur',  nome: 'Wise',       conto: 'EUR',                     iban: 'BE83967250032115',           bic: 'TRWIBEB1XXX',   valuta: 'EUR', saldo: 0, vincoli: 0 },
      { id: 'wise_usd',  nome: 'Wise',       conto: 'USD',                     iban: 'ROUTING 026073150',          bic: 'ACC 311374358', valuta: 'USD', saldo: 0, vincoli: 0 }
    ]
  };
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!d.saldi_banche) d.saldi_banche = defaultSaldiBanche();
    return d;
  } catch {
    return { saldo_iniziale: 0, voci_manuali: [], saldi_banche: defaultSaldiBanche() };
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    Firebird.attach(DB_OPTIONS, (err, db) => {
      if (err) return reject(err);
      db.query(sql, params, (err, result) => {
        db.detach();
        if (err) return reject(err);
        resolve(result || []);
      });
    });
  });
}

// Per DML (UPDATE/INSERT/DELETE): transazione esplicita + commit
function execute(sql, params = []) {
  return new Promise((resolve, reject) => {
    Firebird.attach(DB_OPTIONS, (err, db) => {
      if (err) return reject(err);
      db.transaction(Firebird.ISOLATION_READ_COMMITTED, (err, tr) => {
        if (err) { db.detach(); return reject(err); }
        tr.query(sql, params, (err, result) => {
          if (err) {
            tr.rollback(() => db.detach());
            return reject(err);
          }
          tr.commit((err) => {
            db.detach();
            if (err) return reject(err);
            resolve(result || []);
          });
        });
      });
    });
  });
}

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`;
}

function isoDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString().slice(0,10);
}

// ─── GET CASHFLOW DATA ────────────────────────────────────
app.get('/api/cashflow', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."Importo", p."DataScad", p."IDAnagr", p."Saldato",
             p."NomePagamDoc", p."IDDoc",
             a."Nome", a."Cliente", a."Fornitore"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."Saldato" = 0
        AND p."DataScad" >= CURRENT_DATE
      ORDER BY p."DataScad" ASC
    `);

    const data = loadData();
    const incassi = [];
    const pagamenti = [];

    rows.forEach(r => {
      const imp = Number(r.importo) || 0;
      const entry = {
        data_scad: isoDate(r.datascad),
        data_fmt: fmtDate(r.datascad),
        importo: Math.abs(imp),
        nome: (r.nome || '').trim(),
        tipo_pagam: (r.nomepagamdoc || '').trim(),
        id_doc: r.iddoc
      };
      if (imp > 0) incassi.push({ ...entry, tipo: 'incasso' });
      else if (imp < 0) pagamenti.push({ ...entry, tipo: 'pagamento' });
    });

    res.json({
      saldo_iniziale: data.saldo_iniziale,
      voci_manuali: data.voci_manuali || [],
      incassi,
      pagamenti
    });
  } catch(e) {
    console.error('Errore cashflow:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET RIBA ────────────────────────────────────────────
app.get('/api/riba', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad", p."Saldato",
             p."NomePagamDoc", p."RifPagam", p."DataPagam",
             p."IDAnagr", p."IDDoc",
             a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."CategPagamento" = 'Riba'
        AND p."Saldato" = 0
      ORDER BY p."DataScad" ASC
    `);

    const data = loadData();
    const presentate = data.riba_presentate || {};

    const riba = rows.map(r => {
      const id = r.idprimanota;
      const imp = Number(r.importo) || 0;
      const info = presentate[id] || {};
      return {
        id,
        data_scad: isoDate(r.datascad),
        data_fmt: fmtDate(r.datascad),
        importo: Math.abs(imp),
        segno: imp >= 0 ? 1 : -1,
        nome: (r.nome || '').trim(),
        rata: (r.nomepagamdoc || '').trim(),
        rif: (r.rifpagam || '').trim(),
        id_doc: r.iddoc,
        presentata: info.presentata || false,
        data_presentazione: info.data_presentazione || null,
        banca: info.banca || null
      };
    });

    // Solo RiBa attive (clienti, importo > 0)
    const ribaAttive = riba.filter(r => r.segno > 0);

    // Raggruppa per data scadenza
    const byDate = {};
    ribaAttive.forEach(r => {
      const k = r.data_scad || 'N/D';
      if (!byDate[k]) byDate[k] = { data_scad: r.data_scad, data_fmt: r.data_fmt, items: [], totale: 0, presentate: 0 };
      byDate[k].items.push(r);
      byDate[k].totale += r.importo;
      if (r.presentata) byDate[k].presentate++;
    });

    const gruppi = Object.values(byDate).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    const totAttese     = ribaAttive.filter(r => !r.presentata).reduce((s,r) => s+r.importo, 0);
    const totPresentate = ribaAttive.filter(r =>  r.presentata).reduce((s,r) => s+r.importo, 0);

    res.json({ riba: ribaAttive, gruppi, totAttese, totPresentate });
  } catch(e) {
    console.error('Errore /api/riba:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET RIBA FORNITORI (passive) ────────────────────────
app.get('/api/riba-fornitori', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad", p."Saldato",
             p."NomePagamDoc", p."RifPagam",
             p."IDAnagr", p."IDDoc",
             a."Nome"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."CategPagamento" = 'Riba'
        AND p."Saldato" = 0
        AND p."Importo" < 0
      ORDER BY p."DataScad" ASC
    `);

    const riba = rows.map(r => ({
      id: r.idprimanota,
      data_scad: isoDate(r.datascad),
      data_fmt: fmtDate(r.datascad),
      importo: Math.abs(Number(r.importo) || 0),
      nome: (r.nome || '').trim(),
      rata: (r.nomepagamdoc || '').trim(),
      rif: (r.rifpagam || '').trim(),
      id_doc: r.iddoc
    }));

    // Raggruppa per data scadenza
    const byDate = {};
    riba.forEach(r => {
      const k = r.data_scad || 'N/D';
      if (!byDate[k]) byDate[k] = { data_scad: r.data_scad, data_fmt: r.data_fmt, items: [], totale: 0 };
      byDate[k].items.push(r);
      byDate[k].totale += r.importo;
    });
    const gruppi = Object.values(byDate).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);

    // Raggruppa per fornitore
    const byFornitore = {};
    riba.forEach(r => {
      const k = r.nome || 'N/D';
      if (!byFornitore[k]) byFornitore[k] = { nome: k, items: [], totale: 0 };
      byFornitore[k].items.push(r);
      byFornitore[k].totale += r.importo;
    });
    const fornitori = Object.values(byFornitore).sort((a,b) => b.totale - a.totale);

    const totale = riba.reduce((s,r) => s+r.importo, 0);
    const scadute = riba.filter(r => r.data_scad && r.data_scad < new Date().toISOString().slice(0,10)).reduce((s,r) => s+r.importo, 0);

    res.json({ riba, gruppi, fornitori, totale, scadute });
  } catch(e) {
    console.error('Errore /api/riba-fornitori:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── GENERA FILE CBI RIBA ────────────────────────────────
app.post('/api/riba/genera-cbi', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

    const SIA   = 'P6844';
    const ABI   = '05424';
    const CAB   = '01601';
    const CONTO = '000077061293';
    const CF_AEC   = '12520320156';
    const NOME_AEC = 'AEC INTERNATIONAL SRL';
    const IND_AEC  = 'AEC INTERNATIONAL SRL - 20045 LAINATE';
    const PROV_AEC = 'MI';

    const pad  = (s, n, c=' ') => String(s||'').toUpperCase().substring(0,n).padEnd(n, c);
    const padL = (s, n, c='0') => String(s||'').substring(0,n).padStart(n, c);
    const dateCBI = d => {
      if (!d) return '000000';
      const dt = new Date(d);
      return String(dt.getDate()).padStart(2,'0') +
             String(dt.getMonth()+1).padStart(2,'0') +
             String(dt.getFullYear()).slice(2);
    };
    const extractABICAB = coord => {
      if (!coord) return { abi:'00000', cab:'00000' };
      const m = coord.match(/ABI\s*(\d{5})\s*CAB\s*(\d{5})/i);
      if (m) return { abi: m[1], cab: m[2] };
      return { abi:'00000', cab:'00000' };
    };

    const rows = await query(
      `SELECT p."IDPrimaNota", p."Importo", p."DataScad",
              p."RifPagam", p."NomePagamDoc",
              a."Nome", a."Indirizzo", a."Cap", a."Citta", a."Prov",
              a."CodiceFiscale", a."PartitaIva", a."CoordBancarieDefault"
       FROM "TPrimaNota" p
       LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
       WHERE p."IDPrimaNota" IN (${ids.join(',')})
         AND p."Saldato" = 0 AND p."Importo" > 0
       ORDER BY p."DataScad" ASC, a."Nome" ASC`
    );

    if (!rows.length) return res.status(404).json({ error: 'Nessuna RiBa trovata' });

    const dataCreaz  = dateCBI(new Date());
    const idDistinta = padL(Date.now().toString().slice(-19), 19);
    let records = [];
    let totCentesimi = 0;
    const nRiba = rows.length;
    const nRec  = 1 + nRiba * 7 + 1; // IB + 7*N + EF

    // ── Record IB ──────────────────────────────────────────
    // [0]=' ' [1:3]='IB' [3]='1' [4:9]=SIA(5) [9:14]=ABI(5) [14:20]=data(6)
    // [20:39]=ID(19) [39:113]=spazi(74) [113]='E' [114:120]=spazi(6)
    records.push(' IB1' + pad(SIA,5) + pad(ABI,5) + dataCreaz + idDistinta +
                 ' '.repeat(74) + 'E' + ' '.repeat(6));

    rows.forEach((r, idx) => {
      const prog    = padL(idx+1, 7);
      const imp     = Math.round(Math.abs(Number(r.importo)||0) * 100);
      totCentesimi += imp;
      const dataSc  = dateCBI(r.datascad);
      const rifArch = padL(Math.floor(Math.random()*9999999999), 10);
      const cfDeb   = (r.codicefiscale || r.partitaiva || '').trim();
      const causale = ((r.rifpagam || (r.nomepagamdoc ? 'RATA '+r.nomepagamdoc : 'PAGAMENTO FATTURA'))).toUpperCase();

      // ── Record 14 ──────────────────────────────────────
      // [0]=' ' [1:3]='14' [3:10]=prog(7) [10:22]=spazi(12) [22:28]=data(6)
      // [28]='3' [29:46]=importo(17) [46]='-' [47:52]=ABI(5) [52:57]=CAB(5)
      // [57:69]=conto(12) [69:79]=rif(10) [79:91]=spazi(12) [91]='1'
      // [92:97]=SIA(5) [97:119]=spazi(22) [119]='E'
      records.push(
        ' 14' + prog + ' '.repeat(12) + dataSc + '3' + padL(imp,17) + '-' +
        ABI + CAB + CONTO + rifArch +
        ' '.repeat(12) + '1' + SIA + ' '.repeat(22) + 'E'
      );

      // ── Record 20 ──────────────────────────────────────
      // [10:50]=nome cred(40) [50:58]=spazi(8) [58:96]=ind(38)
      // [96:98]=spazi [98:100]=prov? [100:120]=spazi
      // Analisi originale: [96:106]='        MI' → prov a pos 106 no...
      // Originale: '        AEC...LAINATE         MI              '
      // [50:58]='        ' [58:96]='AEC INTERNATIONAL SRL - 20045 LAINATE ' [96:106]='        MI' [106:120]=spazi
      records.push(
        ' 20' + prog + pad(NOME_AEC,40) +
        ' '.repeat(8) + pad(IND_AEC,38) +
        ' '.repeat(8) + pad(PROV_AEC,2) + ' '.repeat(14)
      );

      // ── Record 30 ──────────────────────────────────────
      // [10:50]=nome deb(40) [50:70]=spazi(20) [70:81]=CF(11) [81:120]=spazi(39)
      records.push(
        ' 30' + prog + pad(r.nome||'',40) +
        ' '.repeat(20) + pad(cfDeb,11) + ' '.repeat(39)
      );

      // ── Record 40 ──────────────────────────────────────
      // [10:35]=ind(25) [35:40]=spazi(5) [40:45]=CAP(5) [45:65]=citta(20)
      // [65:68]=spazi(3) [68:70]=prov(2) [70:120]=spazi(50)
      records.push(
        ' 40' + prog + pad(r.indirizzo||'',25) +
        ' '.repeat(5) + pad(r.cap||'',5) + pad(r.citta||'',20) +
        ' '.repeat(3) + pad(r.prov||'',2) + ' '.repeat(50)
      );

      // ── Record 50 ──────────────────────────────────────
      // [10:90]=causale(80) [90:100]=spazi(10) [100:111]=CF cred(11) [111:120]=spazi(9)
      records.push(
        ' 50' + prog + pad(causale,80) +
        ' '.repeat(10) + pad(CF_AEC,11) + ' '.repeat(9)
      );

      // ── Record 51 ──────────────────────────────────────
      // [10:20]=n.riba(10) [20:40]=nome cred(20) [40:120]=spazi(80)
      records.push(
        ' 51' + prog + padL(idx+1,10) +
        pad(NOME_AEC.substring(0,20),20) + ' '.repeat(80)
      );

      // ── Record 70 ──────────────────────────────────────
      // [10:100]=spazi(90) [100]='1' [101:120]=spazi(19)
      records.push(' 70' + prog + ' '.repeat(90) + '1' + ' '.repeat(19));
    });

    // ── Record EF ──────────────────────────────────────────
    // [0]=' ' [1:3]='EF' [3]='1' [4:9]=SIA(5) [9:14]=ABI(5) [14:20]=data(6)
    // [20:39]=ID(19) [39:45]=spazi(6) [45:53]=n.riba(8) [53:67]=tot.cent(14)
    // [67:75]=zeri(8) [75:89]=n.record(14) [89:113]=spazi(24) [113]='E' [114:120]=spazi(6)
    records.push(
      ' EF1' + pad(SIA,5) + pad(ABI,5) + dataCreaz + idDistinta +
      ' '.repeat(6) + padL(nRiba,8) + padL(totCentesimi,14) +
      padL(0,8) + padL(nRec,14) +
      ' '.repeat(24) + 'E' + ' '.repeat(6)
    );

    // Verifica lunghezze
    records.forEach((rec,i) => {
      if(rec.length !== 120) console.error(`Record ${i} (tipo ${rec.substring(1,3)}): ${rec.length} chars`);
    });

    const cbi = records.join('\r\n') + '\r\n';
    const oggi = new Date();
    const fname = `Riba_${String(oggi.getDate()).padStart(2,'0')}-${String(oggi.getMonth()+1).padStart(2,'0')}-${oggi.getFullYear()}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=latin-1');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(cbi, 'latin1'));

  } catch(e) {
    console.error('Errore genera CBI:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── MARCA RIBA COME PRESENTATA / NON PRESENTATA ─────────
app.post('/api/riba/presenta', (req, res) => {
  const { ids, presentata, data_presentazione, banca } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const data = loadData();
  if (!data.riba_presentate) data.riba_presentate = {};
  ids.forEach(id => {
    if (presentata) {
      data.riba_presentate[id] = {
        presentata: true,
        data_presentazione: data_presentazione || new Date().toISOString().slice(0,10),
        banca: banca || null
      };
    } else {
      delete data.riba_presentate[id];
    }
  });
  saveData(data);
  res.json({ ok: true, updated: ids.length });
});

// ─── GET WISE EXPORT ─────────────────────────────────────
app.get('/api/wise-export', async (req, res) => {
  try {
    const rows = await query(`
      SELECT p."IDPrimaNota", p."Importo", p."DataScad",
             p."NomePagamDoc", p."RifPagam", p."IDDoc",
             p."IDAnagr",
             a."Nome", a."Email", a."CoordBancarieDefault", a."Nazione",
             (SELECT FIRST 1 d."Pagam_CoordBancarie"
              FROM "TDocTestate" d
              WHERE d."IDAnagr" = p."IDAnagr"
                AND d."Pagam_CoordBancarie" IS NOT NULL
                AND d."Pagam_CoordBancarie" <> ''
              ORDER BY d."IDDoc" DESC) AS "DocCoordBancarie"
      FROM "TPrimaNota" p
      LEFT JOIN "TAnagrafica" a ON a."IDAnagr" = p."IDAnagr"
      WHERE p."Saldato" = 0
        AND p."Importo" < 0
        AND (p."CategPagamento" IS NULL OR p."CategPagamento" <> 'Riba')
      ORDER BY p."DataScad" ASC
    `);

    // Regex estrazione IBAN
    const ibanRegex = /[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}/;

    // Carica IBAN manuali salvati
    const data = loadData();
    const ibanManuali = data.wise_iban_manuali || {};

    const voci = rows.map(r => {
      // Priorità: 1) Pagam_CoordBancarie da ultima fattura, 2) CoordBancarieDefault anagrafica
      const coordRaw = (r.doccoordbancarie || r.coordbancariedefault || '').trim();
      const match = coordRaw.match(ibanRegex);
      const ibanDanea = match ? match[0].replace(/\s/g, '') : null;
      const ibanManuale = ibanManuali[String(r.idanagr)] || null;
      const iban = ibanDanea || ibanManuale;

      // Prima email (separatore ; o ,)
      const emailRaw = (r.email || '').trim();
      const email = emailRaw.split(/[;,]/)[0].trim() || null;

      return {
        id: r.idprimanota,
        id_anagr: r.idanagr,
        nome: (r.nome || '').trim(),
        email,
        importo: Math.abs(Number(r.importo) || 0),
        data_scad: isoDate(r.datascad),
        data_fmt: fmtDate(r.datascad),
        rata: (r.nomepagamdoc || '').trim(),
        rif: (r.rifpagam || '').trim(),
        coord_raw: coordRaw,
        iban,
        iban_manuale: !!ibanManuale,
        iban_ok: !!iban,
        nazione: (r.nazione || '').trim()
      };
    });

    // Aggrega per fornitore (stesso IDAnagr) — somma importi stessa scadenza
    const byAnagr = {};
    voci.forEach(v => {
      const k = v.id_anagr + '_' + v.data_scad;
      if (!byAnagr[k]) {
        byAnagr[k] = { ...v, importo: 0, ids: [], rate: [] };
      }
      byAnagr[k].importo += v.importo;
      byAnagr[k].ids.push(v.id);
      if (v.rata) byAnagr[k].rate.push(v.rata);
    });

    const righe = Object.values(byAnagr).sort((a,b) => (a.data_scad||'') < (b.data_scad||'') ? -1 : 1);
    const totale = righe.reduce((s,r) => s+r.importo, 0);
    const senzaIban = righe.filter(r => !r.iban_ok).length;

    res.json({ righe, totale, senzaIban });
  } catch(e) {
    console.error('Errore /api/wise-export:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── SALVA IBAN MANUALE FORNITORE ────────────────────────
app.post('/api/wise-iban', (req, res) => {
  const { id_anagr, iban } = req.body;
  if (!id_anagr) return res.status(400).json({ error: 'id_anagr required' });
  const data = loadData();
  if (!data.wise_iban_manuali) data.wise_iban_manuali = {};
  if (iban) {
    data.wise_iban_manuali[String(id_anagr)] = iban.replace(/\s/g,'').toUpperCase();
  } else {
    delete data.wise_iban_manuali[String(id_anagr)];
  }
  saveData(data);
  res.json({ ok: true });
});

// ─── GET OPERAZIONI IN CORSO ─────────────────────────────
app.get('/api/operazioni', (req, res) => {
  const data = loadData();
  res.json(data.operazioni_in_corso || []);
});

// ─── ADD OPERAZIONE IN CORSO ──────────────────────────────
app.post('/api/operazioni', (req, res) => {
  const data = loadData();
  if (!data.operazioni_in_corso) data.operazioni_in_corso = [];
  const op = {
    id: Date.now(),
    banca: req.body.banca || '',
    tipo: req.body.tipo || 'uscita',
    data: req.body.data || '',
    descrizione: req.body.descrizione || '',
    importo: Math.abs(Number(req.body.importo) || 0)
  };
  data.operazioni_in_corso.push(op);
  saveData(data);
  res.json({ ok: true, op });
});

// ─── DELETE OPERAZIONE IN CORSO ───────────────────────────
app.delete('/api/operazioni/:id', (req, res) => {
  const data = loadData();
  data.operazioni_in_corso = (data.operazioni_in_corso || []).filter(o => o.id !== Number(req.params.id));
  saveData(data);
  res.json({ ok: true });
});

// ─── SEGNA PAGATI IN DANEA ───────────────────────────────
app.post('/api/wise/segna-pagati', async (req, res) => {
  try {
    const { ids, data_pagamento } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

    // Sanitizza: solo numeri interi
    const safeIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    if (!safeIds.length) return res.status(400).json({ error: 'ids non validi' });

    // Formato data YYYY-MM-DD per Firebird
    const dataPag = (data_pagamento || new Date().toISOString().slice(0,10)).slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPag)) return res.status(400).json({ error: 'formato data non valido' });

    // Prima verifica: leggi stato attuale
    const prima = await query(`SELECT "IDPrimaNota", "Saldato", "DataPagam" FROM "TPrimaNota" WHERE "IDPrimaNota" IN (${safeIds.join(',')})`);
    console.log('PRIMA update:', JSON.stringify(prima));

    // Esegui UPDATE con transazione esplicita
    const sql = `UPDATE "TPrimaNota" SET "Saldato" = 1, "DataPagam" = '${dataPag}' WHERE "IDPrimaNota" IN (${safeIds.join(',')}) AND "Saldato" = 0`;
    console.log('SQL:', sql);
    await execute(sql);

    // Dopo: verifica che l'UPDATE abbia funzionato
    const dopo = await query(`SELECT "IDPrimaNota", "Saldato", "DataPagam" FROM "TPrimaNota" WHERE "IDPrimaNota" IN (${safeIds.join(',')})`);
    console.log('DOPO update:', JSON.stringify(dopo));

    const aggiornati = dopo.filter(r => r.saldato === 1).length;
    const falliti = dopo.filter(r => r.saldato !== 1).map(r => r.idprimanota);

    if (falliti.length > 0) {
      console.error('UPDATE NON riuscita per IDs:', falliti);
      res.json({ ok: false, error: `UPDATE non committata. IDs non aggiornati: ${falliti.join(', ')}`, aggiornati, falliti, prima, dopo });
    } else {
      res.json({ ok: true, aggiornati, prima, dopo });
    }
  } catch(e) {
    console.error('Errore segna-pagati:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DEBUG: TEST UPDATE CON LOG PASSO-PASSO ─────────────
app.get('/api/debug/test-update', (req, res) => {
  const log = [];
  const id = 17842;

  log.push('1. Connessione a Firebird...');
  Firebird.attach(DB_OPTIONS, (err, db) => {
    if (err) return res.json({ log, error: 'attach: ' + err.message });
    log.push('2. Connesso. Leggo stato PRIMA...');

    db.query(`SELECT "Saldato", "DataPagam" FROM "TPrimaNota" WHERE "IDPrimaNota" = ${id}`, (err, prima) => {
      if (err) { db.detach(); return res.json({ log, error: 'select prima: ' + err.message }); }
      log.push('3. PRIMA: ' + JSON.stringify(prima));

      log.push('4. Inizio transazione esplicita...');
      db.transaction(Firebird.ISOLATION_READ_COMMITTED, (err, tr) => {
        if (err) { db.detach(); return res.json({ log, error: 'transaction: ' + err.message }); }
        log.push('5. Transazione aperta. Eseguo UPDATE...');

        const sql = `UPDATE "TPrimaNota" SET "Saldato" = 1, "DataPagam" = '2026-04-02' WHERE "IDPrimaNota" = ${id}`;
        log.push('6. SQL: ' + sql);

        tr.query(sql, (err, result) => {
          if (err) {
            log.push('7. ERRORE update: ' + err.message);
            tr.rollback(() => db.detach());
            return res.json({ log, error: 'update: ' + err.message });
          }
          log.push('7. UPDATE eseguita (result: ' + JSON.stringify(result) + ')');

          log.push('8. COMMIT...');
          tr.commit((err) => {
            if (err) {
              log.push('9. ERRORE commit: ' + err.message);
              db.detach();
              return res.json({ log, error: 'commit: ' + err.message });
            }
            log.push('9. COMMIT OK!');

            log.push('10. Chiudo connessione...');
            db.detach();
            log.push('11. Connessione chiusa. Apro NUOVA connessione per verifica...');

            // Nuova connessione indipendente per verificare
            Firebird.attach(DB_OPTIONS, (err, db2) => {
              if (err) return res.json({ log, error: 'attach2: ' + err.message });
              log.push('12. Nuova connessione aperta. Leggo stato DOPO...');

              db2.query(`SELECT "Saldato", "DataPagam" FROM "TPrimaNota" WHERE "IDPrimaNota" = ${id}`, (err, dopo) => {
                db2.detach();
                if (err) return res.json({ log, error: 'select dopo: ' + err.message });
                log.push('13. DOPO: ' + JSON.stringify(dopo));

                const funziona = dopo && dopo[0] && dopo[0].saldato === 1;
                log.push(funziona ? '14. ✅ UPDATE PERSISTITA!' : '14. ❌ UPDATE NON PERSISTITA!');

                res.json({ log, funziona, prima: prima[0], dopo: dopo[0] });
              });
            });
          });
        });
      });
    });
  });
});

// ─── DEBUG: ANALISI COMPLETA DB DANEA ────────────────────
app.get('/api/debug/saldato', async (req, res) => {
  try {
    // 1) Tutte le tabelle del DB Danea
    const tabelle = await query(`
      SELECT RDB$RELATION_NAME AS nome
      FROM RDB$RELATIONS
      WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL
      ORDER BY RDB$RELATION_NAME
    `);

    // 2) Tabelle che contengono "Sald" o "Pagam" nel nome
    const tabelleRilevanti = tabelle.filter(t =>
      t.nome && (t.nome.includes('Sald') || t.nome.includes('Pagam') || t.nome.includes('Giroconto') ||
                 t.nome.includes('Log') || t.nome.includes('Storico') || t.nome.includes('MovBanca') ||
                 t.nome.includes('Mov') || t.nome.includes('Cassa'))
    );

    // 3) Tabelle con foreign key verso TPrimaNota
    const fk = await query(`
      SELECT rc.RDB$CONSTRAINT_NAME AS fk_name,
             rc.RDB$RELATION_NAME AS from_table,
             isg.RDB$FIELD_NAME AS from_field,
             rc2.RDB$RELATION_NAME AS to_table
      FROM RDB$RELATION_CONSTRAINTS rc
      JOIN RDB$REF_CONSTRAINTS ref ON ref.RDB$CONSTRAINT_NAME = rc.RDB$CONSTRAINT_NAME
      JOIN RDB$RELATION_CONSTRAINTS rc2 ON rc2.RDB$CONSTRAINT_NAME = ref.RDB$CONST_NAME_UKY
      JOIN RDB$INDEX_SEGMENTS isg ON isg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
      WHERE rc.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND (rc2.RDB$RELATION_NAME = 'TPrimaNota' OR rc.RDB$RELATION_NAME = 'TPrimaNota')
    `);

    // 4) Struttura colonne di TPrimaNota (tipo dati)
    const colonne = await query(`
      SELECT rf.RDB$FIELD_NAME AS col_name,
             f.RDB$FIELD_TYPE AS field_type,
             f.RDB$FIELD_LENGTH AS field_length,
             f.RDB$FIELD_SCALE AS field_scale,
             rf.RDB$NULL_FLAG AS not_null
      FROM RDB$RELATION_FIELDS rf
      JOIN RDB$FIELDS f ON f.RDB$FIELD_SOURCE = rf.RDB$FIELD_SOURCE
      WHERE rf.RDB$RELATION_NAME = 'TPrimaNota'
      ORDER BY rf.RDB$FIELD_POSITION
    `);

    // 5) Record 17842 stato attuale
    const rec17842 = await query(`SELECT p.* FROM "TPrimaNota" p WHERE p."IDPrimaNota" = 17842`);

    // 6) Cerco tabelle che referenziano IDPrimaNota 17842
    // Cerca in TDocTestate se c'è un legame via IDDoc
    const docTestata = await query(`SELECT * FROM "TDocTestate" WHERE "IDDoc" = 31872`);

    // 7) Cerco se esiste una tabella di giroconti/movimenti banca
    let giroconti = null;
    try { giroconti = await query(`SELECT FIRST 3 * FROM "TGiroconti" ORDER BY 1 DESC`); } catch(e) { giroconti = 'tabella non esiste'; }

    let movBanca = null;
    try { movBanca = await query(`SELECT FIRST 3 * FROM "TMovBanca" ORDER BY 1 DESC`); } catch(e) { movBanca = 'tabella non esiste'; }

    let logPagam = null;
    try { logPagam = await query(`SELECT FIRST 3 * FROM "TLogPagamenti" ORDER BY 1 DESC`); } catch(e) { logPagam = 'tabella non esiste'; }

    // 8) Confronto: record saldato da Easyfatt (16224) - TUTTI i campi documento collegato
    const docSaldato = await query(`SELECT * FROM "TDocTestate" WHERE "IDDoc" = 27495`);

    // 9) Confronto campo "Saldato" nella testata documento
    let docSaldatoFlag31872 = null;
    let docSaldatoFlag27495 = null;
    try {
      docSaldatoFlag31872 = await query(`SELECT "IDDoc", "Saldato" FROM "TDocTestate" WHERE "IDDoc" = 31872`);
      docSaldatoFlag27495 = await query(`SELECT "IDDoc", "Saldato" FROM "TDocTestate" WHERE "IDDoc" = 27495`);
    } catch(e) { docSaldatoFlag31872 = 'campo Saldato non esiste in TDocTestate'; }

    res.json({
      tutte_le_tabelle: tabelle.map(t => (t.nome||'').trim()),
      tabelle_rilevanti: tabelleRilevanti.map(t => (t.nome||'').trim()),
      foreign_keys_TPrimaNota: fk,
      colonne_TPrimaNota: colonne.map(c => ({
        nome: (c.col_name||'').trim(),
        tipo: c.field_type,
        lunghezza: c.field_length,
        scala: c.field_scale,
        not_null: c.not_null
      })),
      record_17842: rec17842[0] || null,
      doc_testata_31872_nostro: docTestata[0] || null,
      doc_testata_27495_danea: docSaldato[0] || null,
      doc_saldato_flag: { nostro_31872: docSaldatoFlag31872, danea_27495: docSaldatoFlag27495 },
      giroconti,
      movBanca,
      logPagamenti: logPagam
    });
  } catch(e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ─── SAVE SALDO INIZIALE CASHFLOW ─────────────────────────
app.post('/api/saldo', (req, res) => {
  const data = loadData();
  data.saldo_iniziale = Number(req.body.saldo) || 0;
  saveData(data);
  res.json({ ok: true, saldo_iniziale: data.saldo_iniziale });
});

// ─── GET SALDI BANCHE ─────────────────────────────────────
app.get('/api/saldi-banche', (req, res) => {
  const data = loadData();
  res.json(data.saldi_banche);
});

// ─── SAVE SALDI BANCHE ────────────────────────────────────
app.post('/api/saldi-banche', (req, res) => {
  const data = loadData();
  const { banche } = req.body;
  if (!Array.isArray(banche)) return res.status(400).json({ error: 'banche array required' });

  // Merge: update saldo/vincoli per id, keep other fields
  banche.forEach(b => {
    const existing = data.saldi_banche.banche.find(x => x.id === b.id);
    if (existing) {
      existing.saldo = Number(b.saldo) || 0;
      if (existing.vincoli !== undefined) existing.vincoli = Number(b.vincoli) || 0;
    }
  });
  data.saldi_banche.aggiornato_il = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, aggiornato_il: data.saldi_banche.aggiornato_il });
});

// ─── SAVE VOCE MANUALE ────────────────────────────────────
app.post('/api/voce', (req, res) => {
  const data = loadData();
  const voce = {
    id: Date.now(),
    tipo: req.body.tipo,
    descrizione: req.body.descrizione || '',
    importo: Math.abs(Number(req.body.importo) || 0),
    data_scad: req.body.data_scad,
    data_fmt: req.body.data_scad ? req.body.data_scad.split('-').reverse().join('/') : null
  };
  data.voci_manuali = data.voci_manuali || [];
  data.voci_manuali.push(voce);
  saveData(data);
  res.json({ ok: true, voce });
});

// ─── DELETE VOCE MANUALE ──────────────────────────────────
app.delete('/api/voce/:id', (req, res) => {
  const data = loadData();
  data.voci_manuali = (data.voci_manuali || []).filter(v => v.id !== Number(req.params.id));
  saveData(data);
  res.json({ ok: true });
});

const PORT = 8087;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nAEC Cashflow Server avviato su http://0.0.0.0:${PORT}`);
  console.log(`   Rete locale: http://172.17.2.100:${PORT}\n`);
});
