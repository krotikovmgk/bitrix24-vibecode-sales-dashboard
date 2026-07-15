'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FilterValidationError, parseFilters, summarizeDashboard } = require('../lib/dashboard');

test('parseFilters applies the 30-day default and test funnel', () => {
  const filters = parseFilters(new URLSearchParams(), {
    now: new Date('2026-07-14T12:00:00.000Z'),
  });
  assert.equal(filters.from, '2026-06-15');
  assert.equal(filters.to, '2026-07-14');
  assert.equal(filters.categoryId, 9);
  assert.equal(filters.responsible, 'all');
  assert.equal(filters.createdBefore, '2026-07-15T00:00:00.000Z');
});

test('parseFilters rejects an inverted period', () => {
  assert.throws(
    () => parseFilters(new URLSearchParams('from=2026-07-14&to=2026-07-01')),
    FilterValidationError,
  );
});

test('parseFilters accepts only supported responsible modes', () => {
  assert.equal(
    parseFilters(new URLSearchParams('responsible=me')).responsible,
    'me',
  );
  assert.throws(
    () => parseFilters(new URLSearchParams('responsible=another-user')),
    FilterValidationError,
  );
});

test('summarizeDashboard calculates stage totals and KPI without mixing currencies', () => {
  const dashboard = summarizeDashboard({
    filters: { from: '2026-07-01', to: '2026-07-14', categoryId: 9, responsible: 'all' },
    categories: [{ id: 9, name: 'Тестовая воронка' }],
    statuses: [
      { statusId: 'C9:NEW', name: 'Новая', sort: 10, semantics: null },
      { statusId: 'C9:WON', name: 'Успешна', sort: 20, semantics: 'S' },
      { statusId: 'C9:LOSE', name: 'Провалена', sort: 30, semantics: 'F' },
    ],
    deals: [
      { id: 1, title: 'A', amount: 100, currency: 'RUB', stageId: 'C9:NEW', categoryId: 9, assignedById: 1, createdAt: '2026-07-14T10:00:00Z' },
      { id: 2, title: 'B', amount: 300, currency: 'RUB', stageId: 'C9:WON', categoryId: 9, assignedById: 2, createdAt: '2026-07-13T10:00:00Z' },
      { id: 3, title: 'C', amount: 50, currency: 'USD', stageId: 'C9:WON', categoryId: 9, assignedById: 2, createdAt: '2026-07-12T10:00:00Z' },
      { id: 4, title: 'D', amount: 40, currency: 'RUB', stageId: 'C9:LOSE', categoryId: 9, assignedById: 1, createdAt: '2026-07-11T10:00:00Z' },
    ],
    users: [{ id: 1, name: 'Сергей', lastName: 'Кротиков' }],
    currentUser: { id: 1, name: 'Сергей Кротиков', role: 'admin' },
    dealsLimit: 5000,
    truncated: false,
  });

  assert.equal(dashboard.metrics.dealsCount, 4);
  assert.equal(dashboard.metrics.wonCount, 2);
  assert.deepEqual(dashboard.metrics.openAmountsByCurrency, { RUB: 100 });
  assert.deepEqual(dashboard.metrics.averageWonAmountsByCurrency, { RUB: 300, USD: 50 });
  assert.equal(dashboard.stages.find((stage) => stage.stageId === 'C9:WON').count, 2);
  assert.equal(dashboard.latestDeals[0].responsibleName, 'Сергей Кротиков');
  assert.equal(dashboard.latestDeals[1].responsibleName, 'Сотрудник #2');
});
