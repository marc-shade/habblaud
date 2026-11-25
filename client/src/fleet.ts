import './fleet.css';
import { OfficeStore } from './net/store';
import { createWorld } from './world';
import { providerNames, type FleetSnapshot } from '../../shared/fleet';
import { getLocale, registerDictionary, tr } from '../../shared/i18n';

async function start() {
  const language = getLocale();
  if (language === 'en') registerDictionary(language, (await import('../../shared/locales/en')).EN);
  if (language === 'es') registerDictionary(language, (await import('../../shared/locales/es')).ES);
  if (language === 'fr') registerDictionary(language, (await import('../../shared/locales/fr')).FR);
  document.documentElement.lang = language;
  const store = new OfficeStore({ mock: false });
  const world = createWorld(document.querySelector('canvas')!, store);
  const overview = document.querySelector<HTMLButtonElement>('#overview')!;
  overview.textContent = tr('Visão geral');
  overview.onclick = () => world.overview();
  const connection = document.querySelector<HTMLElement>('#connection')!;
  const nodes = document.querySelector<HTMLElement>('#nodes')!;
  const stateNames = { online: tr('Conectado'), offline: tr('Desconectado'), connecting: tr('Conectando…') };
  const activities = {
    working: tr('Trabalhando'),
    idle: tr('Ocioso'),
    waiting: tr('Aguardando'),
    shell: tr('Shell'),
    done: tr('Concluído'),
    offline: tr('Desconectado'),
  };
  let signature = '';
  store.on('connection', (state) => {
    if (state === 'open') return;
    document.body.classList.add('disconnected');
    signature = '';
    nodes.replaceChildren();
    connection.textContent = state === 'closed' ? stateNames.offline : stateNames.connecting;
  });
  store.on('snapshot', (value) => {
    document.body.classList.remove('disconnected');
    const snap = value as FleetSnapshot;
    const online = snap.nodes.filter((n) => n.state === 'online').length;
    connection.textContent = tr('{0}/{1} nós conectados', [online, snap.nodes.length]);
    const next = JSON.stringify([
      snap.nodes.map((n) => [n.state, n.sources]),
      snap.agents.map((a) => [a.id, a.status, a.activity?.text, a.roomId]),
    ]);
    if (next === signature) return;
    signature = next;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.agent : undefined;
    const rows = document.createDocumentFragment();
    for (const node of snap.nodes) {
      const section = document.createElement('article');
      const title = document.createElement('h2');
      title.textContent = node.name;
      const state = document.createElement('p');
      state.textContent = stateNames[node.state];
      state.className = node.state;
      section.append(title, state);
      if (node.state === 'online') {
        const info = document.createElement('p');
        info.className = 'detail';
        info.textContent = node.sources.map((s) => providerNames[s.provider] + (s.ok ? ' ✓' : ' ✕')).join(' · ');
        section.append(info);
      }
      for (const a of snap.agents.filter((a) => a.id.startsWith(node.name + ':'))) {
        const item = document.createElement('button');
        const project = snap.rooms.find((r) => r.id === a.roomId)?.name.slice(node.name.length + 3);
        item.type = 'button';
        item.dataset.agent = a.id;
        item.textContent = [
          providerNames[a.provider ?? 'claude'],
          project,
          a.activity?.text === 'recent-file' ? tr('Atividade recente') : activities[a.status],
          a.activity?.text === 'recent-file' ? undefined : a.activity?.text,
        ]
          .filter(Boolean)
          .join(' · ');
        item.onclick = () => world.focusAgent(a.id);
        section.append(item);
      }
      rows.append(section);
    }
    nodes.replaceChildren(rows);
    if (focused)
      nodes
        .querySelector<HTMLButtonElement>('[data-agent="' + CSS.escape(focused) + '"]')
        ?.focus({ preventScroll: true });
  });
  store.connect();
}
void start();
