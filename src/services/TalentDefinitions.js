'use strict';

/**
 *   Single source of truth for the 9-box taxonomy + recommendations,
 *   ported verbatim from nine-box-tool-enhanced.html so the V2 page
 *   has identical box titles, descriptions and recommendation
 *   actions.
 */

const BOX_DEFINITIONS = [
    {
        potential: 'high',
        performance: 'low',
        title: 'Diamond in the rough',
        description:
            'Either learning new role and needs development. Or mismatch between the person and the role — define new career plan to keep engagement.',
        color: '#e74c3c',
    },
    {
        potential: 'high',
        performance: 'medium',
        title: 'Shooting Star',
        description:
            'Strong potential, may deliver beyond current role. Performance meets expectations but does not excel. Promotable to at least 1 level up within 2-3 years.',
        color: '#3498db',
    },
    {
        potential: 'high',
        performance: 'high',
        title: 'Gold Star',
        description:
            'Very strong and consistent performance. Exceptional potential — ready to take on a role at least 1 level up immediately.',
        color: '#f39c12',
    },
    {
        potential: 'medium',
        performance: 'low',
        title: 'Dilemma',
        description:
            'New to organisation or role. Shows capability/skill — may have future potential.',
        color: '#e74c3c',
    },
    {
        potential: 'medium',
        performance: 'medium',
        title: 'Critical Contributor',
        description:
            'Good performer — may take on additional responsibilities. Room to grow; further assessment needed on growth potential.',
        color: '#27ae60',
    },
    {
        potential: 'medium',
        performance: 'high',
        title: 'Emerging Star',
        description:
            'Very strong and consistent performance. May progress one step up within 1-3 years. Needs development to unlock full potential.',
        color: '#3498db',
    },
    {
        potential: 'low',
        performance: 'low',
        title: 'Concern',
        description:
            'Performing below expectations and/or trending downwards; no sign of further potential — requires action.',
        color: '#e74c3c',
    },
    {
        potential: 'low',
        performance: 'medium',
        title: 'Essential Contributor',
        description:
            'Competent but may not excel in higher role — maintain in current position while assessing potential. Keep engaged.',
        color: '#27ae60',
    },
    {
        potential: 'low',
        performance: 'high',
        title: 'Trusted Professional',
        description:
            'Seasoned professional — very valuable. Not promotable in management role, but a potential mentor. Keep engaged.',
        color: '#27ae60',
    },
];

const RECOMMENDATIONS = {
    'Gold Star': [
        {
            title: 'Succession Planning',
            desc: 'Consider for immediate promotion or stretch assignments',
        },
        {
            title: 'Retention Focus',
            desc: 'Ensure competitive compensation and growth opportunities',
        },
        { title: 'Leadership Development', desc: 'Enrol in executive leadership programs' },
    ],
    'Shooting Star': [
        { title: 'Skill Development', desc: 'Focus on areas needed to excel in current role' },
        { title: 'Mentoring', desc: 'Pair with senior leaders for guidance' },
        { title: 'Stretch Projects', desc: 'Assign challenging projects to develop capabilities' },
    ],
    'Diamond in the rough': [
        { title: 'Role Assessment', desc: 'Evaluate if current role is the right fit' },
        { title: 'Intensive Development', desc: 'Provide targeted training and support' },
        { title: 'Regular Check-ins', desc: 'Monitor progress closely with frequent feedback' },
    ],
    'Emerging Star': [
        { title: 'Career Planning', desc: 'Develop clear advancement pathway' },
        { title: 'Cross-functional Exposure', desc: 'Broaden experience across departments' },
        { title: 'Performance Coaching', desc: 'Focus on maintaining high performance standards' },
    ],
    'Critical Contributor': [
        {
            title: 'Performance Improvement',
            desc: 'Set specific goals to reach higher performance levels',
        },
        { title: 'Skill Assessment', desc: 'Identify areas for development and training' },
        { title: 'Regular Feedback', desc: 'Provide ongoing coaching and support' },
    ],
    Dilemma: [
        {
            title: 'Performance Plan',
            desc: 'Create structured improvement plan with clear milestones',
        },
        { title: 'Support Systems', desc: 'Provide additional resources and training' },
        { title: 'Timeline Review', desc: 'Set specific timeframe for improvement assessment' },
    ],
    'Trusted Professional': [
        { title: 'Expert Role', desc: 'Leverage expertise in mentoring and knowledge sharing' },
        { title: 'Engagement Strategy', desc: 'Find ways to keep motivated and challenged' },
        { title: 'Recognition Program', desc: 'Acknowledge contributions and expertise' },
    ],
    'Essential Contributor': [
        {
            title: 'Performance Optimization',
            desc: 'Find ways to maximize effectiveness in current role',
        },
        { title: 'Job Enrichment', desc: 'Add variety and challenges to maintain engagement' },
        { title: 'Stability Focus', desc: 'Ensure job security and clear expectations' },
    ],
    Concern: [
        { title: 'Immediate Action', desc: 'Implement formal performance improvement plan' },
        { title: 'Root Cause Analysis', desc: 'Identify underlying issues affecting performance' },
        { title: 'Decision Timeline', desc: 'Set clear timeline for improvement or transition' },
    ],
};

function titleForBox(box) {
    if (!box) return null;
    const [potential, performance] = box.split('-');
    return BOX_DEFINITIONS.find((b) => b.potential === potential && b.performance === performance);
}

module.exports = { BOX_DEFINITIONS, RECOMMENDATIONS, titleForBox };
