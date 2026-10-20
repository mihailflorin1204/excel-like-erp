import { defineSheet } from '../types.ts';

export const CLAIM_STATES = ['Draft', 'Submitted', 'Approved', 'Paid', 'Rejected'] as const;
export const CLAIM_CATEGORIES = ['Travel', 'Meals', 'Lodging', 'Supplies', 'Training', 'Other'] as const;
export const EMPLOYEE_STATUSES = ['Active', 'Left'] as const;

export const departmentsSheet = defineSheet({
  key: 'departments',
  label: 'Departments',
  module: 'hr',
  description: 'Teams. Expense claims carry their employee’s department onto the ledger (see Department costs).',
  columns: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, maxLength: 20, width: 100 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120, width: 220 },
    { key: 'headcount', label: 'Headcount', type: 'number', computed: true, width: 100 },
  ],
});

export const employeesSheet = defineSheet({
  key: 'employees',
  label: 'Employees',
  module: 'hr',
  description: 'People who can claim expenses. Use the same email as their login so they can’t approve their own claims. Only admins change emails.',
  columns: [
    { key: 'code', label: 'Code', type: 'text', required: true, unique: true, maxLength: 20, width: 90 },
    { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 120, width: 200 },
    { key: 'email', label: 'Email', type: 'text', unique: true, maxLength: 120, width: 210 },
    { key: 'department', label: 'Department', type: 'ref', ref: { sheet: 'departments', display: 'code' }, width: 110 },
    { key: 'title', label: 'Title', type: 'text', maxLength: 80, width: 160 },
    { key: 'startDate', label: 'Start date', type: 'date', width: 110 },
    { key: 'status', label: 'Status', type: 'enum', options: EMPLOYEE_STATUSES, width: 90 },
    // Approved claims not paid yet.
    { key: 'owed', label: 'Owed', type: 'currency', computed: true, width: 105 },
  ],
});

/**
 * Expense claims: Draft → Submit → Approve (Dr expense / Cr Employee payable) → Pay (Dr Employee payable /
 * Cr Bank). An admin approves; nobody approves their own claim.
 */
export const expenseClaimsSheet = defineSheet({
  key: 'expenseClaims',
  label: 'Expense claims',
  module: 'hr',
  description: 'Leave number blank to number it automatically. Submit, then an admin approves and pays. Blank account = Travel and expenses.',
  actions: [
    { key: 'submit', label: 'Submit', description: 'Send the claim for approval; it is locked afterwards' },
    { key: 'approve', label: 'Approve', description: 'Admins: book the claim as owed to the employee' },
    { key: 'reject', label: 'Reject', description: 'Admins: turn a submitted claim down' },
    { key: 'pay', label: 'Pay', description: 'Admins: record that the employee was paid, dated today' },
    { key: 'reverse', label: 'Reverse', description: 'Admins: cancel the approval of a claim that is not paid yet (back to Submitted)' },
  ],
  lockRule: {
    column: 'state',
    editableWhen: ['Draft'],
    alwaysEditable: ['notes'],
    deletableWhen: ['Draft', 'Rejected'],
    message: 'This claim is no longer a draft: only Notes can change.',
  },
  columns: [
    { key: 'number', label: 'Claim', type: 'text', unique: true, maxLength: 20, width: 105 },
    { key: 'employee', label: 'Employee', type: 'ref', required: true, ref: { sheet: 'employees', display: 'code' }, width: 100 },
    { key: 'date', label: 'Date', type: 'date', defaultToday: true, width: 110 },
    { key: 'category', label: 'Category', type: 'enum', required: true, options: CLAIM_CATEGORIES, width: 105 },
    { key: 'description', label: 'Description', type: 'text', maxLength: 200, width: 220 },
    { key: 'amount', label: 'Amount', type: 'currency', required: true, min: 0, width: 105 },
    { key: 'account', label: 'Expense account', type: 'ref', ref: { sheet: 'accounts', display: 'code' }, width: 125 },
    { key: 'receiptUrl', label: 'Receipt link', type: 'text', maxLength: 500, width: 180 },
    { key: 'status', label: 'Status', type: 'text', computed: true, width: 100 },
    { key: 'department', label: 'Department', type: 'ref', ref: { sheet: 'departments', display: 'code' }, computed: true, width: 110 },
    { key: 'notes', label: 'Notes', type: 'text', maxLength: 300, width: 180 },
    { key: 'submittedBy', label: 'Submitted by', type: 'text', system: true, width: 160 },
    { key: 'approvedBy', label: 'Approved by', type: 'text', system: true, width: 160 },
    { key: 'paidDate', label: 'Paid', type: 'date', system: true, width: 105 },
    { key: 'state', label: 'State', type: 'enum', options: CLAIM_STATES, system: true, hidden: true },
    // Who entered the claim, and the employee's email when it was submitted: none of them may decide on it.
    { key: 'createdBy', label: 'Created by', type: 'text', system: true, hidden: true },
    { key: 'employeeEmail', label: 'Employee email', type: 'text', system: true, hidden: true },
    { key: 'journalEntry', label: 'Journal entry', type: 'text', system: true, hidden: true },
    { key: 'paymentEntry', label: 'Payment entry', type: 'text', system: true, hidden: true },
  ],
});

/** Report: expenses per department and account for a date range, from posted journal lines. */
export const departmentCostsSheet = defineSheet({
  key: 'departmentCosts',
  label: 'Department costs',
  module: 'hr',
  description: 'Posted expense lines per department and account. Lines without a department show as (none). Read-only.',
  virtual: true,
  params: [
    { key: 'from', label: 'From' },
    { key: 'to', label: 'To' },
  ],
  columns: [
    { key: 'department', label: 'Department', type: 'ref', ref: { sheet: 'departments', display: 'code' }, computed: true, width: 115 },
    { key: 'departmentName', label: 'Department name', type: 'text', computed: true, width: 190 },
    { key: 'account', label: 'Account', type: 'ref', ref: { sheet: 'accounts', display: 'code' }, computed: true, width: 100 },
    { key: 'accountName', label: 'Account name', type: 'text', computed: true, width: 220 },
    { key: 'amount', label: 'Amount', type: 'currency', computed: true, width: 120 },
  ],
});
