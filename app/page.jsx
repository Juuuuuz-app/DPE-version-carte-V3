"use client\";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import dynamic from "next/dynamic";
import "leaflet/dist/leaflet.css";

// Load react-leaflet components dynamically to avoid SSR issues
const MapContainer = dynamic(() => import("react-leaflet").then(m => m.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import("react-leaflet").then(m => m.TileLayer), { ssr: false });
const Marker = dynamic(() => import("react-leaflet").then(m => m.Marker), { ssr: false });
const Popup = dynamic(() => import("react-leaflet").then(m => m.Popup), { ssr: false });

// Fix default marker icon in Next.js (set URLs from CDN to avoid asset loader config)
import L from "leaflet";
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const formatDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR");
};

const toISO = (val) => {
  if (!val) return "";
  const ok = /^\\d{4}-\\d{2}-\\d{2}$/.test(val);
  return ok ? val : "";
};

const buildQs = ({
  postalCode,
  communePrefix,
  surfaceMin,
  surfaceMax,
  dpeLabels,
  buildingType,
  startDate,
  endDate,
}) => {
  const parts = [];
  if (buildingType && buildingType.trim() !== "") {
    parts.push("type_batiment:" + buildingType.trim().toLowerCase());
  }
  if (postalCode && postalCode.trim() !== "") {
    const pc = postalCode.trim();
    parts.push("((code_postal_ban:" + pc + " OR code_postal_brut:" + pc + "))");
  }
  if (communePrefix && communePrefix.trim() !== "") {
    const cp = communePrefix.trim().replace(/\\s+/g, "?");
    parts.push("nom_commune_ban:" + cp + "*");
  }
  if ((surfaceMin && String(surfaceMin).trim() !== "") || (surfaceMax && String(surfaceMax).trim() !== "")) {
    const min = String(surfaceMin || "").trim() || "*";
    const max = String(surfaceMax || "").trim() || "*";
    parts.push("surface_habitable_logement:[" + min + " TO " + max + "]");
  }
  if (Array.isArray(dpeLabels) && dpeLabels.length > 0) {
    const labs = dpeLabels.map((l) => String(l || "").toUpperCase()).filter(Boolean);
    if (labs.length > 0) parts.push("etiquette_dpe:(" + labs.join(" OR ") + ")");
  }
  if ((startDate && startDate !== "") || (endDate && endDate !== "")) {
    const a = toISO(startDate) || "*";
    const b = toISO(endDate) || "*";
    parts.push("date_etablissement_dpe:[" + a + " TO " + b + "]");
  }
  return parts.join(" AND ");
};

export default function Page() {
  const [postalCode, setPostalCode] = useState("42450");
  const [communePrefix, setCommunePrefix] = useState("");
  const [surfaceMin, setSurfaceMin] = useState("");
  const [surfaceMax, setSurfaceMax] = useState("");
  const [dpeLabels, setDpeLabels] = useState([]);
  const [buildingType, setBuildingType] = useState("maison");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([]);

  const [showMap, setShowMap] = useState(false);
  const mapRef = useRef(null);

  const qs = useMemo(
    () => buildQs({ postalCode, communePrefix, surfaceMin, surfaceMax, dpeLabels, buildingType, startDate, endDate }),
    [postalCode, communePrefix, surfaceMin, surfaceMax, dpeLabels, buildingType, startDate, endDate]
  );

  const url = useMemo(() => {
    const base = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";
    const params = new URLSearchParams({ size: "500", sort: "-date_etablissement_dpe", qs });
    return base + "?" + params.toString();
  }, [qs]);

  const fetchData = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      let out = Array.isArray(data && data.results) ? data.results : [];

      const a = startDate ? new Date(startDate) : null;
      const b = endDate ? new Date(endDate) : null;
      if (a || b) {
        out = out.filter((row) => {
          const d = row?.date_etablissement_dpe ? new Date(row.date_etablissement_dpe) : null;
          if (!d || Number.isNaN(d)) return false;
          if (a && d < a) return false;
          if (b && d > b) return false;
          return true;
        });
      }
      if (Array.isArray(dpeLabels) && dpeLabels.length > 0) {
        const setLabs = new Set(dpeLabels.map((x) => x.toUpperCase()));
        out = out.filter((row) => setLabs.has(String(row?.etiquette_dpe || "").toUpperCase()));
      }
      if (buildingType && buildingType.trim() !== "") {
        out = out.filter((row) => String(row?.type_batiment || "").toLowerCase() === buildingType.toLowerCase());
      }

      setRows(out);
    } catch (e) {
      setError(e?.message || "Erreur de chargement");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // Fit map to markers when rows or map instance changes
  useEffect(() => {
    if (!showMap || !mapRef.current) return;
    const map = mapRef.current;
    const pts = rows
      .map(r => {
        const lat = parseFloat(r?.coordonnee_cartographique_y_ban ?? r?.y_ban ?? r?.y);
        const lon = parseFloat(r?.coordonnee_cartographique_x_ban ?? r?.x_ban ?? r?.x);
        if (Number.isFinite(lat) && Number.isFinite(lon)) return [lat, lon];
        return null;
      })
      .filter(Boolean);

    if (pts.length === 0) {
      map.setView([46.7, 2.5], 6);
    } else if (pts.length === 1) {
      map.setView(pts[0], 12);
    } else {
      const bounds = L.latLngBounds(pts.map(([lat, lon]) => L.latLng(lat, lon)));
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [showMap, rows]);

  const resetFilters = () => {
    setCommunePrefix("");
    setSurfaceMin("");
    setSurfaceMax("");
    setStartDate("");
    setEndDate("");
    setDpeLabels([]);
    setBuildingType("maison");
  };

  const toggleLabel = (l, checked) => {
    setDpeLabels((prev) => checked ? [...prev, l] : prev.filter((x) => x !== l));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 text-white shadow">
        <div className="max-w-6xl mx-auto px-4 py-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">DPE VISUALISER</h1>
          <div className="text-sm opacity-90">Filtrage avancé • max 500</div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Code postal</label>
            <input className="px-3 py-2 rounded-xl border bg-white" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} placeholder="Ex: 42450" inputMode="numeric" />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Commune (commence par)</label>
            <input className="px-3 py-2 rounded-xl border bg-white" value={communePrefix} onChange={(e) => setCommunePrefix(e.target.value)} placeholder="Ex: Su (pour Sury...)" />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Surface min (m²)</label>
            <input className="px-3 py-2 rounded-xl border bg-white" value={surfaceMin} onChange={(e) => setSurfaceMin(e.target.value)} placeholder="Ex: 60" inputMode="numeric" />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Surface max (m²)</label>
            <input className="px-3 py-2 rounded-xl border bg-white" value={surfaceMax} onChange={(e) => setSurfaceMax(e.target.value)} placeholder="Ex: 120" inputMode="numeric" />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Type de bâtiment</label>
            <select className="px-3 py-2 rounded-xl border bg-white" value={buildingType} onChange={(e) => setBuildingType(e.target.value)}>
              <option value="">Tous</option>
              <option value="maison">Maison</option>
              <option value="appartement">Appartement</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Date d'établissement — début (optionnel)</label>
            <input type="date" className="px-3 py-2 rounded-xl border bg-white" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Date d'établissement — fin (optionnel)</label>
            <input type="date" className="px-3 py-2 rounded-xl border bg-white" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </motion.div>

        <section className="bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Étiquettes DPE</div>
            <div className="text-xs opacity-60">{dpeLabels.length > 0 ? "Sélection : " + dpeLabels.join(", ") : "Toutes"}</div>
          </div>
          <div className="grid grid-cols-8 gap-2 mt-3">
            {"ABCDEFG".split("").map((l) => {
              const checked = dpeLabels.includes(l);
              const classNames = "flex items-center justify-center px-2 py-2 rounded-lg border text-sm cursor-pointer select-none" + (checked ? " bg-black text-white" : " bg-white");
              return (
                <label key={l} className={classNames}>
                  <input type="checkbox" className="mr-2 accent-black" checked={checked} onChange={(e) => toggleLabel(l, e.target.checked)} />
                  {l}
                </label>
              );
            })}
          </div>
        </section>

        <div className="flex items-center gap-2">
          <button onClick={fetchData} className="px-4 py-2 rounded-xl bg-black text-white shadow hover:shadow-lg active:scale-95 transition">Appliquer les filtres</button>
          <button onClick={resetFilters} className="px-4 py-2 rounded-xl bg-white border shadow hover:shadow-lg active:scale-95 transition">Réinitialiser</button>
          <button onClick={() => setShowMap((v) => !v)} className="px-4 py-2 rounded-xl bg-white border shadow hover:shadow-lg active:scale-95 transition">
            {showMap ? 'Masquer la carte' : 'Afficher sur la carte'}
          </button>
        </div>

        {error !== "" && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700">
            <strong>Erreur</strong> : {error}
          </div>
        )}

        <section className="bg-white rounded-2xl shadow p-4">
          <div className="flex justify-between items-center mb-2">
            <div className="text-sm opacity-70">{rows.length} résultat(s)</div>
            <a href={url} target="_blank" className="text-sm underline text-blue-600">Ouvrir l'appel API</a>
          </div>

          {!loading && rows.length === 0 && (
            <div className="p-6 text-center text-sm opacity-70">Aucun résultat avec ces filtres. Essayez d'élargir la recherche.</div>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left border-b">
                  <th className="py-2 pr-4"># DPE</th>
                  <th className="py-2 pr-4">Date établ.</th>
                  <th className="py-2 pr-4">Etiq. DPE</th>
                  <th className="py-2 pr-4">Etiq. GES</th>
                  <th className="py-2 pr-4">Année constr.</th>
                  <th className="py-2 pr-4">Surface (m²)</th>
                  <th className="py-2 pr-4">Adresse</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 10 }).map((_, i) => (
                      <tr key={i} className="animate-pulse border-b last:border-0">
                        <td className="py-2 pr-4"><div className="h-4 w-24 bg-gray-200 rounded" /></td>
                        <td className="py-2 pr-4"><div className="h-4 w-20 bg-gray-200 rounded" /></td>
                        <td className="py-2 pr-4"><div className="h-4 w-6 bg-gray-200 rounded" /></td>
                        <td className="py-2 pr-4"><div className="h-4 w-6 bg-gray-200 rounded" /></td>
                        <td className="py-2 pr-4"><div className="h-4 w-12 bg-gray-200 rounded" /></td>
                        <td className="py-2 pr-4"><div className="h-4 w-10 bg-gray-200 rounded" /></td>
                        <td className="py-2 pr-4"><div className="h-4 w-64 bg-gray-200 rounded" /></td>
                      </tr>
                    ))
                  : rows.map((r) => {
                      const lat = parseFloat(r?.coordonnee_cartographique_y_ban ?? r?.y_ban ?? r?.y);
                      const lon = parseFloat(r?.coordonnee_cartographique_x_ban ?? r?.x_ban ?? r?.x);
                      return (
                        <tr key={r.numero_dpe} className="border-b last:border-0 hover:bg-gray-50">
                          <td className="py-2 pr-4 font-medium">{r.numero_dpe}</td>
                          <td className="py-2 pr-4">{formatDate(r.date_etablissement_dpe)}</td>
                          <td className="py-2 pr-4"><span className="inline-flex items-center px-2 py-0.5 rounded-full border text-xs">{r.etiquette_dpe || "—"}</span></td>
                          <td className="py-2 pr-4">{r.etiquette_ges || "—"}</td>
                          <td className="py-2 pr-4">{r.annee_construction || r.periode_construction || "—"}</td>
                          <td className="py-2 pr-4">{(r.surface_habitable_logement ?? "—")}</td>
                          <td className="py-2 pr-4 max-w-[420px] truncate">{r.adresse_ban || "—"}{(!Number.isFinite(lat) || !Number.isFinite(lon)) && " (coordonnées indisponibles)"}</td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          </div>
        </section>

        {showMap && (
          <section className="bg-white rounded-2xl shadow p-4">
            <div className="mb-2 text-sm font-medium">Carte</div>
            <MapContainer
              center={[46.7, 2.5]}
              zoom={6}
              whenCreated={(map) => (mapRef.current = map)}
              className="w-full h-[420px] rounded-xl border"
            >
              <TileLayer
                attribution='&copy; OpenStreetMap contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {rows.map((r) => {
                const lat = parseFloat(r?.coordonnee_cartographique_y_ban ?? r?.y_ban ?? r?.y);
                const lon = parseFloat(r?.coordonnee_cartographique_x_ban ?? r?.x_ban ?? r?.x);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
                return (
                  <Marker key={r.numero_dpe} position={[lat, lon]}>
                    <Popup>
                      <div style={{ fontSize: 12 }}>
                        <strong>{r.numero_dpe || ""}</strong><br />
                        {r.adresse_ban || ""}<br />
                        DPE : {r.etiquette_dpe || "—"} / {r.etiquette_ges || "—"}
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
            <div className="text-xs opacity-60 mt-2">Astuce : clique sur un marqueur pour voir le détail (n° DPE, adresse, étiquettes).</div>
          </section>
        )}
      </main>
    </div>
  );
}
