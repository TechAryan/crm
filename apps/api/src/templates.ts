/**
 * Vertical starter templates — the "working CRM in 60 seconds" differentiator.
 * Each template pre-seeds stages, sources, lead fields, scoring activity types,
 * and opportunity types tuned for a specific SMB vertical.
 */
export interface VerticalTemplate {
  code: string;
  name: string;
  description: string;
  stages: { name: string; active: boolean; order: number; isDefault?: boolean }[];
  sources: string[];
  leadFields: { label: string; type: string; options?: string[] }[];
  activityTypes: { name: string; direction: 0 | 1; score: number }[];
  opportunityTypes: { name: string; stages: { name: string; status: 'Open' | 'Won' | 'Lost' }[] }[];
}

export const TEMPLATES: Record<string, VerticalTemplate> = {
  generic: {
    code: 'generic', name: 'General Sales', description: 'A clean default pipeline for any business',
    stages: [
      { name: 'New', active: true, order: 10, isDefault: true }, { name: 'Contacted', active: true, order: 20 },
      { name: 'Qualified', active: true, order: 30 }, { name: 'Customer', active: true, order: 40 },
      { name: 'Not Interested', active: false, order: 50 }, { name: 'Invalid', active: false, order: 60 },
    ],
    sources: ['Website', 'WhatsApp', 'Meta', 'Manual', 'Bulk Import', 'Referral'],
    leadFields: [],
    activityTypes: [{ name: 'Call Made', direction: 1, score: 5 }, { name: 'Email Sent', direction: 1, score: 2 }, { name: 'Meeting Done', direction: 1, score: 10 }],
    opportunityTypes: [{ name: 'Standard Deal', stages: [
      { name: 'Qualification', status: 'Open' }, { name: 'Proposal', status: 'Open' }, { name: 'Negotiation', status: 'Open' },
      { name: 'Closed Won', status: 'Won' }, { name: 'Closed Lost', status: 'Lost' }] }],
  },
  ecommerce: {
    code: 'ecommerce', name: 'E-commerce / D2C', description: 'Online stores: cart follow-ups, orders, repeat buyers',
    stages: [
      { name: 'New', active: true, order: 10, isDefault: true }, { name: 'Contacted', active: true, order: 20 },
      { name: 'Cart Follow-up', active: true, order: 30 }, { name: 'Ordered', active: true, order: 40 },
      { name: 'Repeat Customer', active: true, order: 50 }, { name: 'Not Interested', active: false, order: 60 },
    ],
    sources: ['Website', 'WhatsApp', 'Meta', 'Instagram Shop', 'Marketplace', 'Referral', 'Bulk Import', 'Manual'],
    leadFields: [
      { label: 'Product Interest', type: 'text' }, { label: 'Cart Value', type: 'currency' },
      { label: 'City', type: 'text' }, { label: 'Preferred Contact Time', type: 'dropdown', options: ['Morning', 'Afternoon', 'Evening'] },
    ],
    activityTypes: [
      { name: 'Order Placed', direction: 0, score: 15 }, { name: 'Cart Abandoned', direction: 0, score: -5 },
      { name: 'Delivery Issue Raised', direction: 0, score: 0 }, { name: 'Review Received', direction: 0, score: 5 },
      { name: 'Follow-up Call', direction: 1, score: 5 },
    ],
    opportunityTypes: [{ name: 'Order', stages: [
      { name: 'Cart', status: 'Open' }, { name: 'Payment Pending', status: 'Open' },
      { name: 'Paid', status: 'Won' }, { name: 'Cancelled', status: 'Lost' }] }],
  },
  education: {
    code: 'education', name: 'Education / Coaching', description: 'Coaching institutes & edtech: counselling, demos, enrollments',
    stages: [
      { name: 'New', active: true, order: 10, isDefault: true }, { name: 'Counselling', active: true, order: 20 },
      { name: 'Demo Scheduled', active: true, order: 30 }, { name: 'Demo Done', active: true, order: 40 },
      { name: 'Enrolled', active: true, order: 50 }, { name: 'Dropped', active: false, order: 60 },
    ],
    sources: ['Website', 'WhatsApp', 'Meta', 'Walk-in', 'Student Referral', 'Bulk Import', 'Manual'],
    leadFields: [
      { label: 'Course Interest', type: 'text' }, { label: 'Exam Target', type: 'text' },
      { label: 'Class / Grade', type: 'dropdown', options: ['8', '9', '10', '11', '12', 'Dropper', 'College', 'Working'] },
      { label: 'Parent Phone', type: 'phone' }, { label: 'City', type: 'text' },
    ],
    activityTypes: [
      { name: 'Counselling Session', direction: 1, score: 10 }, { name: 'Demo Attended', direction: 0, score: 15 },
      { name: 'Fee Discussion', direction: 1, score: 5 }, { name: 'Parent Call', direction: 1, score: 5 },
    ],
    opportunityTypes: [{ name: 'Enrollment', stages: [
      { name: 'Counselling', status: 'Open' }, { name: 'Fee Negotiation', status: 'Open' },
      { name: 'Enrolled', status: 'Won' }, { name: 'Lost to Competitor', status: 'Lost' }, { name: 'Dropped', status: 'Lost' }] }],
  },
  astrology: {
    code: 'astrology', name: 'Astrology / Spirituality', description: 'Consultations, pujas, courses & memberships',
    stages: [
      { name: 'New', active: true, order: 10, isDefault: true }, { name: 'Consultation Booked', active: true, order: 20 },
      { name: 'Consulted', active: true, order: 30 }, { name: 'Member', active: true, order: 40 },
      { name: 'Inactive', active: false, order: 50 },
    ],
    sources: ['Website', 'WhatsApp', 'Meta', 'YouTube', 'Instagram', 'Referral', 'Bulk Import', 'Manual'],
    leadFields: [
      { label: 'Birth Date', type: 'date' }, { label: 'Birth Time', type: 'text' }, { label: 'Birth Place', type: 'text' },
      { label: 'Service Interest', type: 'dropdown', options: ['Kundli Reading', 'Consultation', 'Puja', 'Gemstone', 'Course', 'Membership'] },
      { label: 'Preferred Language', type: 'dropdown', options: ['Hindi', 'English', 'Other'] },
    ],
    activityTypes: [
      { name: 'Consultation Done', direction: 1, score: 10 }, { name: 'Puja Booked', direction: 0, score: 15 },
      { name: 'Report Delivered', direction: 1, score: 5 }, { name: 'Follow-up Call', direction: 1, score: 5 },
    ],
    opportunityTypes: [{ name: 'Service Booking', stages: [
      { name: 'Enquiry', status: 'Open' }, { name: 'Scheduled', status: 'Open' },
      { name: 'Completed & Paid', status: 'Won' }, { name: 'Cancelled', status: 'Lost' }] }],
  },
  creator: {
    code: 'creator', name: 'Creator / YouTuber', description: 'Sponsorships, courses, memberships & merch for creators',
    stages: [
      { name: 'New', active: true, order: 10, isDefault: true }, { name: 'Engaged', active: true, order: 20 },
      { name: 'In Discussion', active: true, order: 30 }, { name: 'Closed', active: true, order: 40 },
      { name: 'Not a Fit', active: false, order: 50 },
    ],
    sources: ['YouTube', 'Instagram', 'Website', 'WhatsApp', 'Community', 'Email', 'Bulk Import', 'Manual'],
    leadFields: [
      { label: 'Deal Type', type: 'dropdown', options: ['Sponsorship', 'Course Sale', 'Membership', 'Merch', 'Collab'] },
      { label: 'Brand / Company', type: 'text' }, { label: 'Budget Range', type: 'dropdown', options: ['<50k', '50k-2L', '2L-10L', '10L+'] },
      { label: 'Platform', type: 'multiselect', options: ['YouTube', 'Instagram', 'Podcast', 'Newsletter'] },
    ],
    activityTypes: [
      { name: 'Sponsor Call', direction: 1, score: 10 }, { name: 'Deliverables Agreed', direction: 1, score: 15 },
      { name: 'Content Delivered', direction: 1, score: 10 }, { name: 'Payment Received', direction: 0, score: 20 },
    ],
    opportunityTypes: [{ name: 'Deal', stages: [
      { name: 'Enquiry', status: 'Open' }, { name: 'Negotiation', status: 'Open' }, { name: 'Contract Sent', status: 'Open' },
      { name: 'Signed & Paid', status: 'Won' }, { name: 'Lost', status: 'Lost' }] }],
  },
  agency: {
    code: 'agency', name: 'Digital Marketing Agency', description: 'Client acquisition: discovery, proposals, retainers',
    stages: [
      { name: 'New', active: true, order: 10, isDefault: true }, { name: 'Discovery Call', active: true, order: 20 },
      { name: 'Proposal Sent', active: true, order: 30 }, { name: 'Client', active: true, order: 40 },
      { name: 'Lost', active: false, order: 50 },
    ],
    sources: ['Website', 'WhatsApp', 'Meta', 'LinkedIn', 'Referral', 'Cold Outreach', 'Bulk Import', 'Manual'],
    leadFields: [
      { label: 'Company', type: 'text' }, { label: 'Monthly Budget', type: 'currency' },
      { label: 'Services Needed', type: 'multiselect', options: ['SEO', 'Paid Ads', 'Social Media', 'Web Development', 'Content', 'Branding'] },
      { label: 'Industry', type: 'text' },
    ],
    activityTypes: [
      { name: 'Discovery Call', direction: 1, score: 10 }, { name: 'Audit Delivered', direction: 1, score: 10 },
      { name: 'Proposal Sent', direction: 1, score: 5 }, { name: 'Contract Signed', direction: 0, score: 20 },
    ],
    opportunityTypes: [{ name: 'Retainer', stages: [
      { name: 'Discovery', status: 'Open' }, { name: 'Proposal', status: 'Open' }, { name: 'Negotiation', status: 'Open' },
      { name: 'Signed', status: 'Won' }, { name: 'Lost', status: 'Lost' }] },
    { name: 'One-time Project', stages: [
      { name: 'Scoping', status: 'Open' }, { name: 'Quoted', status: 'Open' },
      { name: 'Delivered & Paid', status: 'Won' }, { name: 'Cancelled', status: 'Lost' }] }],
  },
};
