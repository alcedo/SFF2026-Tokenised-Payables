import { describe, expect, it } from 'vitest';

import { activeNavHref } from '../nav-active';

const ADATA = ['/adata', '/adata/create', '/adata/approvals', '/adata/settlement'];
const SUPPLIER = ['/supplier', '/supplier/offers', '/transfer'];
const LENDER = ['/lender', '/lender/portfolio', '/transfer'];
const ADMIN = ['/admin', '/admin/certification', '/admin/grading', '/admin/accounts'];

describe('the current tab follows the pathname', () => {
  it('matches an exact tab', () => {
    expect(activeNavHref(ADATA, '/adata/approvals')).toBe('/adata/approvals');
    expect(activeNavHref(SUPPLIER, '/transfer')).toBe('/transfer');
  });

  it('prefers the longest matching tab over its parent', () => {
    expect(activeNavHref(ADATA, '/adata/create')).toBe('/adata/create');
    expect(activeNavHref(LENDER, '/lender/portfolio')).toBe('/lender/portfolio');
    expect(activeNavHref(ADMIN, '/admin/accounts')).toBe('/admin/accounts');
  });

  it('lights the parent tab for a detail page under it', () => {
    expect(activeNavHref(SUPPLIER, '/supplier/finance/42')).toBe('/supplier');
    expect(activeNavHref(LENDER, '/lender/7')).toBe('/lender');
  });

  it('lights the root tab on its own path', () => {
    expect(activeNavHref(ADATA, '/adata')).toBe('/adata');
    expect(activeNavHref(ADMIN, '/admin')).toBe('/admin');
  });

  it('only matches on a segment boundary', () => {
    expect(activeNavHref(ADMIN, '/administration')).toBeNull();
    expect(activeNavHref(SUPPLIER, '/suppliers')).toBeNull();
  });

  it('lights nothing on pages outside every tab', () => {
    expect(activeNavHref(ADATA, '/')).toBeNull();
    expect(activeNavHref(ADATA, '/onboarding')).toBeNull();
    expect(activeNavHref(SUPPLIER, '/explorer')).toBeNull();
    expect(activeNavHref(LENDER, '/overdue')).toBeNull();
  });

  it('does not depend on tab order', () => {
    expect(activeNavHref([...ADATA].reverse(), '/adata/settlement')).toBe('/adata/settlement');
    expect(activeNavHref([...ADATA].reverse(), '/adata')).toBe('/adata');
  });

  it('returns null for an empty tab list', () => {
    expect(activeNavHref([], '/adata')).toBeNull();
  });
});
