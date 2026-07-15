'use strict';

const elements = {
  form: document.querySelector('#filters'),
  category: document.querySelector('#category'),
  responsible: document.querySelector('#responsible'),
  from: document.querySelector('#date-from'),
  to: document.querySelector('#date-to'),
  refresh: document.querySelector('#refresh'),
  notice: document.querySelector('#notice'),
  user: document.querySelector('#current-user'),
  open: document.querySelector('#metric-open'),
  won: document.querySelector('#metric-won'),
  average: document.querySelector('#metric-average'),
  count: document.querySelector('#metric-count'),
  stages: document.querySelector('#stages'),
  deals: document.querySelector('#deals'),
  period: document.querySelector('#period-label'),
  generatedAt: document.querySelector('#generated-at'),
};

const numberFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
let dashboardSessionId = '';
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  elements.from.value = isoDate(from);
  elements.to.value = isoDate(to);
}

function formatMoney(value, currency) {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(Number(value) || 0);
  } catch {
    return `${numberFormatter.format(Number(value) || 0)} ${currency}`;
  }
}

function formatAmounts(amounts) {
  const entries = Object.entries(amounts || {});
  if (!entries.length) return formatMoney(0, 'RUB');
  return entries.map(([currency, value]) => formatMoney(value, currency)).join(' + ');
}

function td(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderCategories(categories, selectedId) {
  const previous = elements.category.value;
  elements.category.replaceChildren();
  for (const category of categories) {
    const option = document.createElement('option');
    option.value = String(category.id);
    option.textContent = category.name;
    elements.category.append(option);
  }
  const preferred = String(selectedId ?? previous);
  if ([...elements.category.options].some((option) => option.value === preferred)) {
    elements.category.value = preferred;
  }
}

function renderStages(stages) {
  elements.stages.replaceChildren();
  if (!stages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'В выбранной воронке нет стадий.';
    elements.stages.append(empty);
    return;
  }

  for (const stage of stages) {
    const article = document.createElement('article');
    article.className = 'stage';
    article.dataset.semantic = stage.semantics;

    const top = document.createElement('div');
    top.className = 'stage__top';
    const label = document.createElement('div');
    label.className = 'stage__name';
    label.textContent = stage.name;
    const id = document.createElement('span');
    id.className = 'stage__id';
    id.textContent = ` · ${stage.stageId}`;
    label.append(id);

    const numbers = document.createElement('div');
    numbers.className = 'stage__numbers';
    const count = document.createElement('strong');
    count.textContent = `${numberFormatter.format(stage.count)} шт.`;
    const amount = document.createElement('span');
    amount.textContent = formatAmounts(stage.amountsByCurrency);
    numbers.append(count, amount);
    top.append(label, numbers);

    const bar = document.createElement('div');
    bar.className = 'stage__bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, stage.share * 100))}%`;
    bar.append(fill);
    article.append(top, bar);
    elements.stages.append(article);
  }
}

function renderDeals(deals) {
  elements.deals.replaceChildren();
  if (!deals.length) {
    const row = document.createElement('tr');
    const cell = td('За выбранный период сделок не найдено.', 'empty');
    cell.colSpan = 4;
    row.append(cell);
    elements.deals.append(row);
    return;
  }

  for (const deal of deals) {
    const row = document.createElement('tr');
    const title = td(deal.title, 'deal-title');
    const meta = document.createElement('span');
    meta.textContent = `#${deal.id} · ${deal.createdAt ? dateTimeFormatter.format(new Date(deal.createdAt)) : 'без даты'}`;
    title.append(meta);

    const stageCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'stage-badge';
    badge.dataset.semantic = deal.stageSemantics;
    badge.textContent = deal.stageName;
    badge.title = deal.stageId;
    stageCell.append(badge);

    row.append(
      title,
      stageCell,
      td(deal.responsibleName),
      td(formatMoney(deal.amount, deal.currency), 'numeric'),
    );
    elements.deals.append(row);
  }
}

function render(data) {
  renderCategories(data.categories, data.filters.categoryId);
  elements.user.textContent = `${data.currentUser.name} · ${data.currentUser.role === 'admin' ? 'администратор' : 'сотрудник'}`;
  elements.open.textContent = formatAmounts(data.metrics.openAmountsByCurrency);
  elements.won.textContent = numberFormatter.format(data.metrics.wonCount);
  elements.average.textContent = formatAmounts(data.metrics.averageWonAmountsByCurrency);
  elements.count.textContent = numberFormatter.format(data.metrics.dealsCount);
  elements.period.textContent = `${dateFormatter.format(new Date(`${data.filters.from}T00:00:00`))} — ${dateFormatter.format(new Date(`${data.filters.to}T00:00:00`))}`;
  elements.generatedAt.textContent = `Обновлено ${dateTimeFormatter.format(new Date(data.generatedAt))}`;
  renderStages(data.stages);
  renderDeals(data.latestDeals);

  const notes = [];
  notes.push(data.filters.categoryName);
  notes.push(data.filters.responsible === 'me' ? 'только мои сделки' : 'все доступные сделки');
  if (data.meta.multipleCurrencies) notes.push('суммы разных валют показаны раздельно');
  if (data.meta.truncated) notes.push(`выборка ограничена ${data.meta.dealsLimit} сделками`);
  elements.notice.className = 'notice';
  elements.notice.textContent = notes.join(' · ');
}

async function loadDashboard() {
  elements.notice.className = 'notice';
  elements.notice.textContent = 'Загружаем данные CRM…';
  const buttons = elements.form.querySelectorAll('button');
  buttons.forEach((button) => { button.disabled = true; });

  const params = new URLSearchParams(new FormData(elements.form));
  try {
    const response = await fetch(`/api/dashboard?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        ...(dashboardSessionId ? { 'X-Dashboard-Session': dashboardSessionId } : {}),
      },
      cache: 'no-store',
    });
    const payload = await response.json();
    if (payload.sessionId) dashboardSessionId = payload.sessionId;
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error?.message || 'Не удалось загрузить данные.');
    }
    render(payload.data);
  } catch (error) {
    elements.notice.className = 'notice notice--error';
    elements.notice.textContent = error.message || 'Не удалось загрузить данные. Повторите попытку.';
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  loadDashboard();
});
elements.refresh.addEventListener('click', loadDashboard);

setDefaultDates();
loadDashboard();
