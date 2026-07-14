// ╔══════════════════════════════════════════════════════════════╗
// ║  Schrijf Superster v1.1 — Cloudflare Worker                 ║
// ║  Vereist: KV namespace gebonden als SCHRIJF_KV              ║
// ║  Vereist: Environment variable ANTHROPIC_API_KEY            ║
// ╚══════════════════════════════════════════════════════════════╝

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function fout(bericht, status = 400) {
  return json({ fout: bericht }, status);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const pad = url.pathname.replace(/\/$/, '');
    const methode = request.method;

    // ── AI PROXY ─────────────────────────────────────────────
    if (pad === '' || pad === '/ai') {
      if (methode !== 'POST') return fout('Alleen POST', 405);
      const body = await request.json();
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return json(data, resp.status);
    }

    // ── GEBRUIKER VERWIJDEREN ─────────────────────────────────
    if (pad === '/gebruiker/verwijder' && methode === 'POST') {
      const { gebruikerId } = await request.json();
      if (!gebruikerId) return fout('gebruikerId verplicht');

      // Verwijder alle pogingen en foto's
      const indexRaw = await env.SCHRIJF_KV.get(`pogingen-index:${gebruikerId}`);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      await Promise.all(index.map(async i => {
        await env.SCHRIJF_KV.delete(`poging:${i.id}`);
        await env.SCHRIJF_KV.delete(`foto:${i.id}`);
        await env.SCHRIJF_KV.delete(`feedback:${i.id}`);
      }));

      // Verwijder index, profiel en ongelezen
      await env.SCHRIJF_KV.delete(`pogingen-index:${gebruikerId}`);
      await env.SCHRIJF_KV.delete(`gebruiker:${gebruikerId}`);
      await env.SCHRIJF_KV.delete(`ongelezen:${gebruikerId}`);

      // Verwijder uit de globale gebruikerslijst
      const lijstRaw = await env.SCHRIJF_KV.get('gebruikers:alle');
      if (lijstRaw) {
        const lijst = JSON.parse(lijstRaw).filter(g => g.id !== gebruikerId);
        await env.SCHRIJF_KV.put('gebruikers:alle', JSON.stringify(lijst));
      }

      return json({ ok: true });
    }
    if (pad === '/gebruiker') {
      if (methode === 'POST') {
        const { naam, emoji } = await request.json();
        if (!naam) return fout('naam verplicht');
        const id = crypto.randomUUID();
        const profiel = { id, naam: naam.trim(), emoji: emoji || '⭐', aangemaakt: new Date().toISOString() };
        await env.SCHRIJF_KV.put(`gebruiker:${id}`, JSON.stringify(profiel));
        const lijstRaw = await env.SCHRIJF_KV.get('gebruikers:alle');
        const lijst = lijstRaw ? JSON.parse(lijstRaw) : [];
        lijst.push({ id, naam: profiel.naam, emoji: profiel.emoji, aangemaakt: profiel.aangemaakt });
        await env.SCHRIJF_KV.put('gebruikers:alle', JSON.stringify(lijst));
        return json(profiel);
      }
      if (methode === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return fout('id verplicht');
        const raw = await env.SCHRIJF_KV.get(`gebruiker:${id}`);
        if (!raw) return fout('Gebruiker niet gevonden', 404);
        return json(JSON.parse(raw));
      }
    }

    // ── ALLE GEBRUIKERS ───────────────────────────────────────
    if (pad === '/gebruikers' && methode === 'GET') {
      const raw = await env.SCHRIJF_KV.get('gebruikers:alle');
      return json(raw ? JSON.parse(raw) : []);
    }

    // ── POGING OPSLAAN ────────────────────────────────────────
    // FIX #2: bestandsgrootte check (18MB base64 ≈ 13MB origineel)
    // FIX #3: pogingen als losse keys opslaan + aparte index om race conditions te voorkomen
    if (pad === '/poging' && methode === 'POST') {
      const body = await request.json();
      const { gebruikerId, opdrachtId, aiScore, foto } = body;
      if (!gebruikerId || !opdrachtId) return fout('gebruikerId en opdrachtId verplicht');

      // FIX #2: foto-grootte check
      if (foto && foto.length > 18_000_000) {
        return fout('Foto is te groot (max ~13MB). Maak een kleinere foto.', 413);
      }

      const pogingId = crypto.randomUUID();
      const datum = new Date().toISOString();

      // Foto apart opslaan
      if (foto) {
        await env.SCHRIJF_KV.put(`foto:${pogingId}`, foto, { expirationTtl: 60 * 60 * 24 * 90 });
      }

      const poging = {
        id: pogingId,
        gebruikerId,
        opdrachtId,
        opdrachtTitel: body.opdrachtTitel || '',
        opdrachtEmoji: body.opdrachtEmoji || '',
        aiScore,
        aiCompliment: body.aiCompliment || '',
        aiTip: body.aiTip || '',
        aiHoofdBoodschap: body.aiHoofdBoodschap || '',
        datum,
        heeftFoto: !!foto,
        heeftFeedback: false,
      };

      // FIX #3: poging als losse key opslaan
      await env.SCHRIJF_KV.put(`poging:${pogingId}`, JSON.stringify(poging));

      // Index bijhouden: lijst van pogingIds per gebruiker
      const indexSleutel = `pogingen-index:${gebruikerId}`;
      const indexRaw = await env.SCHRIJF_KV.get(indexSleutel);
      const index = indexRaw ? JSON.parse(indexRaw) : [];
      index.unshift({ id: pogingId, datum, opdrachtId }); // alleen kleine metadata in index
      if (index.length > 100) index.splice(100);
      await env.SCHRIJF_KV.put(indexSleutel, JSON.stringify(index));

      return json({ pogingId, datum });
    }

    // ── POGINGEN OPHALEN ──────────────────────────────────────
    // FIX #3: pogingen ophalen via losse keys
    if (pad === '/pogingen' && methode === 'GET') {
      const gebruikerId = url.searchParams.get('gebruikerId');
      if (!gebruikerId) return fout('gebruikerId verplicht');

      const indexRaw = await env.SCHRIJF_KV.get(`pogingen-index:${gebruikerId}`);
      const index = indexRaw ? JSON.parse(indexRaw) : [];

      const opdrachtId = url.searchParams.get('opdrachtId');
      const gefilterd = opdrachtId
        ? index.filter(i => String(i.opdrachtId) === opdrachtId)
        : index;

      // Haal volledige pogingen parallel op
      const pogingen = await Promise.all(
        gefilterd.map(async i => {
          const raw = await env.SCHRIJF_KV.get(`poging:${i.id}`);
          return raw ? JSON.parse(raw) : null;
        })
      );

      return json(pogingen.filter(Boolean));
    }

    // ── FOTO OPHALEN ──────────────────────────────────────────
    if (pad === '/foto' && methode === 'GET') {
      const pogingId = url.searchParams.get('pogingId');
      if (!pogingId) return fout('pogingId verplicht');
      const foto = await env.SCHRIJF_KV.get(`foto:${pogingId}`);
      if (!foto) return fout('Foto niet gevonden', 404);
      return json({ foto });
    }

    // ── FEEDBACK OPSLAAN ──────────────────────────────────────
    if (pad === '/feedback' && methode === 'POST') {
      const { pogingId, gebruikerId, jufScore, tekst } = await request.json();
      if (!pogingId || !gebruikerId) return fout('pogingId en gebruikerId verplicht');

      const feedback = {
        pogingId,
        gebruikerId,
        jufScore: jufScore !== undefined && jufScore !== null ? Number(jufScore) : null,
        tekst: tekst || '',
        datum: new Date().toISOString(),
      };
      await env.SCHRIJF_KV.put(`feedback:${pogingId}`, JSON.stringify(feedback));

      // Markeer poging als heeftFeedback: true
      const pogingRaw = await env.SCHRIJF_KV.get(`poging:${pogingId}`);
      if (pogingRaw) {
        const poging = JSON.parse(pogingRaw);
        poging.heeftFeedback = true;
        await env.SCHRIJF_KV.put(`poging:${pogingId}`, JSON.stringify(poging));
      }

      // Markeer als ongelezen voor het kind
      const ongelezen = await env.SCHRIJF_KV.get(`ongelezen:${gebruikerId}`);
      const lijst = ongelezen ? JSON.parse(ongelezen) : [];
      if (!lijst.includes(pogingId)) lijst.push(pogingId);
      await env.SCHRIJF_KV.put(`ongelezen:${gebruikerId}`, JSON.stringify(lijst));

      return json({ ok: true });
    }

    // ── FEEDBACK OPHALEN ──────────────────────────────────────
    if (pad === '/feedback' && methode === 'GET') {
      const pogingId = url.searchParams.get('pogingId');
      if (!pogingId) return fout('pogingId verplicht');
      const raw = await env.SCHRIJF_KV.get(`feedback:${pogingId}`);
      if (!raw) return json(null);
      return json(JSON.parse(raw));
    }

    // ── ONGELEZEN FEEDBACK ────────────────────────────────────
    if (pad === '/ongelezen' && methode === 'GET') {
      const gebruikerId = url.searchParams.get('gebruikerId');
      if (!gebruikerId) return fout('gebruikerId verplicht');
      const raw = await env.SCHRIJF_KV.get(`ongelezen:${gebruikerId}`);
      return json(raw ? JSON.parse(raw) : []);
    }
    if (pad === '/ongelezen/gelezen' && methode === 'POST') {
      const { gebruikerId } = await request.json();
      if (!gebruikerId) return fout('gebruikerId verplicht');
      await env.SCHRIJF_KV.put(`ongelezen:${gebruikerId}`, JSON.stringify([]));
      return json({ ok: true });
    }

    return fout('Niet gevonden', 404);
  },
};
