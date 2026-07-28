export const CANONICAL_PERMISSIONS = [
  {
    name: "dashboard.view",
    module: "Dashboard",
    action: "View",
    description: "View daily revenue summaries, appointment counts, and attendance stats."
  },
  {
    name: "users.view",
    module: "Users",
    action: "View",
    description: "View user authentication profiles."
  },
  {
    name: "users.create",
    module: "Users",
    action: "Create",
    description: "Create user authentication logins and assign roles."
  },
  {
    name: "users.update",
    module: "Users",
    action: "Update",
    description: "Update user statuses (suspend, lock/unlock, edit details)."
  },
  {
    name: "users.delete",
    module: "Users",
    action: "Delete",
    description: "Permanently delete user logins."
  },
  {
    name: "roles.view",
    module: "Roles & Permissions",
    action: "View",
    description: "View role definitions and assigned permission keys."
  },
  {
    name: "roles.create",
    module: "Roles & Permissions",
    action: "Create",
    description: "Register new user roles."
  },
  {
    name: "roles.update",
    module: "Roles & Permissions",
    action: "Update",
    description: "Update permissions assigned to a role."
  },
  {
    name: "roles.delete",
    module: "Roles & Permissions",
    action: "Delete",
    description: "Delete user roles."
  },
  {
    name: "organizations.view",
    module: "Organizations",
    action: "View",
    description: "View organization details, logo, and core setup."
  },
  {
    name: "organizations.update",
    module: "Organizations",
    action: "Update",
    description: "Update primary corporate details."
  },
  {
    name: "branches.view",
    module: "Branches",
    action: "View",
    description: "View lists and details of physical branches."
  },
  {
    name: "branches.create",
    module: "Branches",
    action: "Create",
    description: "Register a new branch location."
  },
  {
    name: "branches.update",
    module: "Branches",
    action: "Update",
    description: "Update branch hours, address, and status."
  },
  {
    name: "branches.delete",
    module: "Branches",
    action: "Delete",
    description: "Disable or archive a physical location."
  },
  {
    name: "customers.view",
    module: "Customers",
    action: "View",
    description: "View customer profile records, preferences, and notes."
  },
  {
    name: "customers.create",
    module: "Customers",
    action: "Create",
    description: "Add a new customer record."
  },
  {
    name: "customers.update",
    module: "Customers",
    action: "Update",
    description: "Edit customer profiles and notes."
  },
  {
    name: "customers.delete",
    module: "Customers",
    action: "Delete",
    description: "Permanently delete customer profiles."
  },
  {
    name: "customers.export",
    module: "Customers",
    action: "Export",
    description: "Export customer profile lists and service history records for reporting/data portability."
  },
  {
    name: "customers.edit",
    module: "Customers",
    action: "Edit",
    description: "Edit customer profile details."
  },
  {
    name: "appointments.view",
    module: "Appointments",
    action: "View",
    description: "View calendar availability and appointment records."
  },
  {
    name: "appointments.book",
    module: "Appointments",
    action: "Book",
    description: "Create standard advance bookings or walk-ins."
  },
  {
    name: "appointments.reschedule",
    module: "Appointments",
    action: "Reschedule",
    description: "Modify appointment booking dates or times."
  },
  {
    name: "appointments.assign_staff",
    module: "Appointments",
    action: "Assign Staff",
    description: "Assign or reallocate stylists/beauticians to appointments."
  },
  {
    name: "appointments.update_status",
    module: "Appointments",
    action: "Update Status",
    description: "Track appointment check-in, execution, and completion."
  },
  {
    name: "appointments.cancel",
    module: "Appointments",
    action: "Cancel",
    description: "Cancel scheduled appointments."
  },
  {
    name: "employees.view",
    module: "Employees",
    action: "View",
    description: "View employee HR profiles, schedules, and rosters."
  },
  {
    name: "employees.create",
    module: "Employees",
    action: "Create",
    description: "Register new employee profiles."
  },
  {
    name: "employees.update",
    module: "Employees",
    action: "Update",
    description: "Modify employee HR details, rosters, or branch allocations."
  },
  {
    name: "employees.delete",
    module: "Employees",
    action: "Delete",
    description: "Offboard or delete employee records."
  },
  {
    name: "employees.leaves.view",
    module: "Employees & Leaves",
    action: "View",
    description: "View employee leave balances and history."
  },
  {
    name: "employees.leaves.manage",
    module: "Employees & Leaves",
    action: "Manage",
    description: "Manage leave requests (submit on behalf of staff, approve, or reject). This single permission intentionally covers the entire leave lifecycle authorization boundary."
  },
  {
    name: "attendance.view",
    module: "Attendance",
    action: "View",
    description: "View check-in records and shift rosters."
  },
  {
    name: "attendance.punch",
    module: "Attendance",
    action: "Punch",
    description: "Check-in or check-out of shifts (self or manager-assisted)."
  },
  {
    name: "attendance.adjust",
    module: "Attendance",
    action: "Adjust",
    description: "Correct shift times or approve missing punch events."
  },
  {
    name: "payroll.view",
    module: "Salary / Payroll",
    action: "View",
    description: "View salary configurations, incentives, and historical payslips."
  },
  {
    name: "payroll.calculate",
    module: "Salary / Payroll",
    action: "Calculate",
    description: "Compute wages, process incentives, and approve payout values."
  },
  {
    name: "services.view",
    module: "Services",
    action: "View",
    description: "View catalog services, base pricing, and duration setup."
  },
  {
    name: "services.create",
    module: "Services",
    action: "Create",
    description: "Register a new service definition."
  },
  {
    name: "services.update",
    module: "Services",
    action: "Update",
    description: "Update service base prices, local pricing rules, durations, and tax/GST attributes."
  },
  {
    name: "services.delete",
    module: "Services",
    action: "Delete",
    description: "Delete or archive a service category/item."
  },
  {
    name: "memberships.view",
    module: "Memberships",
    action: "View",
    description: "View membership plans and customer membership statuses."
  },
  {
    name: "memberships.configure",
    module: "Memberships",
    action: "Configure",
    description: "Define, update, or retire membership packages (Silver, Gold, Platinum)."
  },
  {
    name: "memberships.sell",
    module: "Memberships",
    action: "Sell",
    description: "Purchase/issue memberships for customers."
  },
  {
    name: "memberships.redeem",
    module: "Memberships",
    action: "Redeem",
    description: "Record a membership benefit usage event."
  },
  {
    name: "coupons.view",
    module: "Coupons",
    action: "View",
    description: "Browse promotional and referral coupons."
  },
  {
    name: "coupons.configure",
    module: "Coupons",
    action: "Configure",
    description: "Create, update, or expire coupons, including branch exclusions."
  },
  {
    name: "coupons.apply",
    module: "Coupons",
    action: "Apply",
    description: "Validate and apply coupon discounts during POS checkout."
  },
  {
    name: "billing.view",
    module: "Billing & POS",
    action: "View",
    description: "View invoices, checkout history, and draft lists."
  },
  {
    name: "billing.checkout",
    module: "Billing & POS",
    action: "Checkout",
    description: "Generate invoice details, apply taxes (GST), and complete checkout."
  },
  {
    name: "billing.void",
    module: "Billing & POS",
    action: "Void",
    description: "Cancel or void finalized checkout invoices."
  },
  {
    name: "payments.view",
    module: "Payments",
    action: "View",
    description: "View checkout receipts and outstanding debt registers."
  },
  {
    name: "payments.receive",
    module: "Payments",
    action: "Receive",
    description: "Record transaction payments (Cash, UPI, Card) and resolve outstanding alerts."
  },
  {
    name: "payments.refund",
    module: "Payments",
    action: "Refund",
    description: "Issue client refunds."
  },
  {
    name: "expenses.view",
    module: "Expenses",
    action: "View",
    description: "View daily operational expense logs."
  },
  {
    name: "expenses.create",
    module: "Expenses",
    action: "Create",
    description: "Record operational expenses (petty cash, electricity, rent)."
  },
  {
    name: "expenses.update",
    module: "Expenses",
    action: "Update",
    description: "Modify logged expense details."
  },
  {
    name: "expenses.delete",
    module: "Expenses",
    action: "Delete",
    description: "Delete expense items."
  },
  {
    name: "finance.view",
    module: "Finance",
    action: "View",
    description: "Access corporate cash flow logs, net profits, and consolidated tax ledgers."
  },
  {
    name: "finance.gst_report",
    module: "Finance",
    action: "Export GST",
    description: "Generate and download tax/GST reports."
  },
  {
    name: "inventory.view",
    module: "Inventory",
    action: "View",
    description: "Monitor stock counts, low-stock warnings, and consumption histories."
  },
  {
    name: "inventory.consume",
    module: "Inventory",
    action: "Log Consumption",
    description: "Log internal product consumption by stylists during service delivery."
  },
  {
    name: "inventory.adjust",
    module: "Inventory",
    action: "Adjust",
    description: "Overwrite/update inventory count values during audits (damage/theft adjustments)."
  },
  {
    name: "inventory.transfer",
    module: "Inventory",
    action: "Transfer",
    description: "Authorize and track physical stock transfers between different branches."
  },
  {
    name: "inventory.stocktake",
    module: "Inventory",
    action: "Stocktake",
    description: "Log periodic physical inventory reconciliation reports (stock auditing)."
  },
  {
    name: "procurement.suppliers.view",
    module: "Procurement",
    action: "View Suppliers",
    description: "View supplier records and contract details."
  },
  {
    name: "procurement.suppliers.manage",
    module: "Procurement",
    action: "Manage Suppliers",
    description: "Create, edit, and archive supplier records."
  },
  {
    name: "procurement.orders.view",
    module: "Procurement",
    action: "View Orders",
    description: "View purchase orders and supply bills."
  },
  {
    name: "procurement.orders.create",
    module: "Procurement",
    action: "Create Orders",
    description: "Draft and issue purchase orders to suppliers."
  },
  {
    name: "procurement.orders.update",
    module: "Procurement",
    action: "Update Orders",
    description: "Change order status (e.g., mark as received, update items)."
  },
  {
    name: "procurement.invoices.manage",
    module: "Procurement",
    action: "Manage Invoices",
    description: "Log and match supplier invoices against POs."
  },
  {
    name: "procurement.payments.manage",
    module: "Procurement",
    action: "Manage Payments",
    description: "Track and record payables/payments made to suppliers."
  },
  {
    name: "loyalty.view",
    module: "Loyalty",
    action: "View",
    description: "View rules, configurations, and point balances."
  },
  {
    name: "loyalty.configure",
    module: "Loyalty",
    action: "Configure",
    description: "Edit reward tiers, point multipliers, and expiration rules."
  },
  {
    name: "loyalty.adjust",
    module: "Loyalty",
    action: "Adjust Points",
    description: "Manually award or deduct points for support resolutions."
  },
  {
    name: "reports.revenue.view",
    module: "Reports",
    action: "View Revenue",
    description: "View financial revenue reports and projections."
  },
  {
    name: "reports.performance.view",
    module: "Reports",
    action: "View Performance",
    description: "View employee service hours, commissions, and performance analytics."
  },
  {
    name: "reports.retention.view",
    module: "Reports",
    action: "View Retention",
    description: "View customer visit frequency and retention trends."
  },
  {
    name: "reports.inventory.view",
    module: "Reports",
    action: "View Inventory",
    description: "View stock movements, valuation, and consumption velocities."
  },
  {
    name: "reports.services.view",
    module: "Reports",
    action: "View Services",
    description: "View popular services and service performance analytics."
  },
  {
    name: "whatsapp.config.update",
    module: "WhatsApp",
    action: "Configure",
    description: "Configure API credentials, webhook status, and automatic notifications."
  },
  {
    name: "notifications.templates.update",
    module: "Notifications",
    action: "Update Templates",
    description: "Modify templates for transactional notifications."
  },
  {
    name: "campaigns.send",
    module: "Campaigns",
    action: "Send Campaigns",
    description: "Launch bulk SMS, email, or WhatsApp promo campaigns."
  },
  {
    name: "campaigns.view",
    module: "Campaigns",
    action: "View Campaigns",
    description: "View performance and list of marketing campaigns."
  },
  {
    name: "settings.view",
    module: "Settings",
    action: "View",
    description: "View general configurations and metadata schemas."
  },
  {
    name: "settings.update",
    module: "Settings",
    action: "Update",
    description: "Modify global business metadata, GST schedules, or local configurations."
  },
  {
    name: "settings.backups",
    module: "Settings",
    action: "Manage Backups",
    description: "Trigger manual database dumps or download backups."
  },
  {
    name: "logs.view",
    module: "Settings",
    action: "View Logs",
    description: "Retrieve system audit logs and action histories."
  }
];
