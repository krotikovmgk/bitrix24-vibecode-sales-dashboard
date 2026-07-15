'use strict';

class FilterValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FilterValidationError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function assertDate(value, field) {
  if (!DATE_RE.test(value)) {
    throw new FilterValidationError(`Поле ${field} должно быть датой в формате ГГГГ-ММ-ДД.`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateOnly(parsed) !== value) {
    throw new FilterValidationError(`Поле ${field} содержит некорректную дату.`);
  }
}

function parseFilters(searchParams, options = {}) {
  const now = options.now || new Date();
  const defaultCategoryId = options.defaultCategoryId ?? 9;
  const defaultTo = dateOnly(now);
  const defaultFromDate = new Date(`${defaultTo}T00:00:00.000Z`);
  defaultFromDate.setUTCDate(defaultFromDate.getUTCDate() - 29);

  const from = searchParams.get('from') || dateOnly(defaultFromDate);
  const to = searchParams.get('to') || defaultTo;
  const categoryValue = searchParams.get('categoryId');
  const responsible = searchParams.get('responsible') || 'all';
  const categoryId = categoryValue === null || categoryValue === ''
    ? defaultCategoryId
    : Number(categoryValue);

  assertDate(from, '«Дата с»');
  assertDate(to, '«Дата по»');

  if (!Number.isInteger(categoryId) || categoryId < 0) {
    throw new FilterValidationError('Воронка выбрана некорректно.');
  }
  if (!['all', 'me'].includes(responsible)) {
    throw new FilterValidationError('Фильтр ответственного выбран некорректно.');
  }

  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (fromMs > toMs) {
    throw new FilterValidationError('Начало периода не может быть позже окончания.');
  }
  if ((toMs - fromMs) / 86_400_000 > 366) {
    throw new FilterValidationError('Период не должен превышать 366 дней.');
  }

  return {
    from,
    to,
    categoryId,
    responsible,
    createdFrom: `${from}T00:00:00.000Z`,
    createdBefore: `${addUtcDays(to, 1)}T00:00:00.000Z`,
  };
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addAmount(target, currency, amount) {
  const code = String(currency || 'RUB').toUpperCase();
  target[code] = numberValue(target[code]) + numberValue(amount);
}

function averageByCurrency(totals, counts) {
  return Object.fromEntries(
    Object.entries(totals).map(([currency, total]) => [
      currency,
      counts[currency] ? total / counts[currency] : 0,
    ]),
  );
}

function normalizeStatus(status) {
  return {
    id: String(status.statusId ?? status.STATUS_ID ?? status.id ?? ''),
    name: String(status.name ?? status.NAME ?? status.statusId ?? 'Без названия'),
    sort: numberValue(status.sort ?? status.SORT),
    semantics: String(status.semantics ?? status.SEMANTICS ?? '').toUpperCase(),
  };
}

function normalizeCategory(category) {
  return {
    id: numberValue(category.id ?? category.ID),
    name: String(category.name ?? category.NAME ?? `Воронка ${category.id ?? category.ID}`),
  };
}

function normalizeUser(user) {
  const id = numberValue(user.id ?? user.ID);
  const parts = [
    user.name ?? user.NAME,
    user.lastName ?? user.LAST_NAME,
  ].filter(Boolean);

  return {
    id,
    name: parts.join(' ').trim() || `Сотрудник #${id}`,
  };
}

function normalizeDeal(deal) {
  return {
    id: numberValue(deal.id ?? deal.ID),
    title: String(deal.title ?? deal.TITLE ?? 'Без названия'),
    amount: numberValue(deal.amount ?? deal.OPPORTUNITY),
    currency: String(deal.currency ?? deal.CURRENCY_ID ?? 'RUB').toUpperCase(),
    stageId: String(deal.stageId ?? deal.STAGE_ID ?? 'UNKNOWN'),
    categoryId: numberValue(deal.categoryId ?? deal.CATEGORY_ID),
    assignedById: numberValue(deal.assignedById ?? deal.ASSIGNED_BY_ID),
    createdAt: deal.createdAt ?? deal.DATE_CREATE ?? null,
  };
}

function summarizeDashboard(input) {
  const statuses = (input.statuses || []).map(normalizeStatus).sort((a, b) => a.sort - b.sort);
  const categories = (input.categories || []).map(normalizeCategory).sort((a, b) => a.id - b.id);
  const deals = (input.deals || []).map(normalizeDeal);
  const users = new Map((input.users || []).map(normalizeUser).map((user) => [user.id, user.name]));
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const stageRows = new Map(statuses.map((status) => [status.id, {
    stageId: status.id,
    name: status.name,
    sort: status.sort,
    semantics: status.semantics,
    count: 0,
    amountsByCurrency: {},
  }]));

  const openAmounts = {};
  const wonAmounts = {};
  const wonCountsByCurrency = {};
  let wonCount = 0;

  for (const deal of deals) {
    const status = statusById.get(deal.stageId) || {
      id: deal.stageId,
      name: deal.stageId,
      sort: 10_000,
      semantics: '',
    };
    if (!stageRows.has(deal.stageId)) {
      stageRows.set(deal.stageId, {
        stageId: deal.stageId,
        name: status.name,
        sort: status.sort,
        semantics: status.semantics,
        count: 0,
        amountsByCurrency: {},
      });
    }

    const row = stageRows.get(deal.stageId);
    row.count += 1;
    addAmount(row.amountsByCurrency, deal.currency, deal.amount);

    if (status.semantics === 'S') {
      wonCount += 1;
      addAmount(wonAmounts, deal.currency, deal.amount);
      wonCountsByCurrency[deal.currency] = numberValue(wonCountsByCurrency[deal.currency]) + 1;
    } else if (status.semantics !== 'F') {
      addAmount(openAmounts, deal.currency, deal.amount);
    }
  }

  const stages = [...stageRows.values()]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ru'))
    .map((stage) => ({
      ...stage,
      share: deals.length ? stage.count / deals.length : 0,
    }));

  const latestDeals = [...deals]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id - a.id)
    .slice(0, 15)
    .map((deal) => ({
      ...deal,
      stageName: statusById.get(deal.stageId)?.name || deal.stageId,
      stageSemantics: statusById.get(deal.stageId)?.semantics || '',
      responsibleName: users.get(deal.assignedById) || `Сотрудник #${deal.assignedById}`,
    }));

  const selectedCategory = categories.find((category) => category.id === input.filters.categoryId) || {
    id: input.filters.categoryId,
    name: `Воронка ${input.filters.categoryId}`,
  };

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      from: input.filters.from,
      to: input.filters.to,
      categoryId: input.filters.categoryId,
      categoryName: selectedCategory.name,
      responsible: input.filters.responsible,
    },
    currentUser: input.currentUser,
    categories,
    metrics: {
      dealsCount: deals.length,
      openAmountsByCurrency: openAmounts,
      wonCount,
      averageWonAmountsByCurrency: averageByCurrency(wonAmounts, wonCountsByCurrency),
    },
    stages,
    latestDeals,
    meta: {
      dealsLimit: input.dealsLimit,
      truncated: Boolean(input.truncated),
      multipleCurrencies: new Set(deals.map((deal) => deal.currency)).size > 1,
    },
  };
}

module.exports = {
  FilterValidationError,
  addUtcDays,
  parseFilters,
  summarizeDashboard,
};
