'use strict';
/**
 * OpenAPI 3.0 contract for the IDevelop v1 read API (strangler-fig seam).
 * Served at GET /api/v1/openapi.json. Extend as endpoints are added.
 * @module api/v1/openapi
 */
const pkg = require('../../../package.json');

module.exports = {
    openapi: '3.0.3',
    info: {
        title: 'IDevelop Community Edition API',
        version: (pkg && pkg.version) || '2.0.0',
        description:
            'Versioned JSON API for IDevelop Community Edition (read endpoints). Session-cookie or API-key authenticated; RBAC-scoped.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
        securitySchemes: {
            sessionCookie: {
                type: 'apiKey',
                in: 'cookie',
                name: process.env.SESSION_COOKIE_NAME || 'app.sid',
            },
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
        schemas: {
            Skill: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    category: { type: 'string' },
                    domainId: { type: 'integer', nullable: true },
                    domainName: { type: 'string', nullable: true },
                },
            },
            Readiness: {
                type: 'object',
                properties: {
                    employeeId: { type: 'integer' },
                    employeeName: { type: 'string' },
                    siteName: { type: 'string', nullable: true },
                    departmentName: { type: 'string', nullable: true },
                    roleName: { type: 'string', nullable: true },
                    // The ONE readiness number: computed over the ASSESSED
                    // requirements only (v_employee_assessment_coverage
                    // .readiness_assessed_only). null — never 0 — when nobody
                    // has ever been assessed.
                    readinessPercent: { type: 'number', nullable: true },
                    isReady: { type: 'boolean', nullable: true },
                    totalRequired: { type: 'integer' },
                    skillsMet: { type: 'integer' },
                    // Coverage always travels with the score.
                    assessedSkills: { type: 'integer' },
                    expectedSkills: { type: 'integer' },
                    neverAssessedSkills: { type: 'integer' },
                    coveragePercent: { type: 'number', nullable: true },
                    assessmentStatus: {
                        type: 'string',
                        enum: ['never_assessed', 'self_only', 'assessed'],
                    },
                    // Readiness over EVERY requirement, counting a never-rated
                    // one as a scored 0. Distinct label on purpose.
                    readinessAllRequirementsPercent: { type: 'number', nullable: true },
                },
            },
            Employee: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    employeeNumber: { type: 'string', nullable: true },
                    firstName: { type: 'string' },
                    lastName: { type: 'string' },
                    roleName: { type: 'string', nullable: true },
                    siteName: { type: 'string', nullable: true },
                    departmentName: { type: 'string', nullable: true },
                    isActive: { type: 'boolean' },
                },
            },
            NineBox: {
                type: 'object',
                properties: {
                    employeeId: { type: 'integer' },
                    employeeName: { type: 'string' },
                    performance: { type: 'string', enum: ['low', 'medium', 'high'] },
                    potential: { type: 'string', enum: ['low', 'medium', 'high'] },
                    box: { type: 'integer', nullable: true },
                    label: { type: 'string', nullable: true },
                    placedAt: { type: 'string', format: 'date-time', nullable: true },
                },
            },
            Development: {
                type: 'object',
                properties: {
                    coaching: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                kind: { type: 'string' },
                                title: { type: 'string' },
                                state: { type: 'string' },
                                progress: { type: 'integer' },
                                contextType: { type: 'string', nullable: true },
                            },
                        },
                    },
                    idps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                status: { type: 'string' },
                                objectives: { type: 'integer' },
                                actions: { type: 'integer' },
                                actionsCompleted: { type: 'integer' },
                            },
                        },
                    },
                    pips: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                state: { type: 'string' },
                                outcome: { type: 'string', nullable: true },
                            },
                        },
                    },
                },
            },
            Goal: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    employeeId: { type: 'integer' },
                    parentId: { type: 'integer', nullable: true },
                    kind: { type: 'string', enum: ['objective', 'key_result'] },
                    title: { type: 'string' },
                    description: { type: 'string', nullable: true },
                    metricUnit: { type: 'string', nullable: true },
                    targetValue: { type: 'number', nullable: true },
                    currentValue: { type: 'number' },
                    status: { type: 'string', enum: ['active', 'at_risk', 'done', 'cancelled'] },
                    period: { type: 'string', nullable: true },
                    dueDate: { type: 'string', format: 'date', nullable: true },
                },
            },
            CheckIn: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    employeeId: { type: 'integer' },
                    managerId: { type: 'integer', nullable: true },
                    kind: { type: 'string', enum: ['one_on_one', 'feedback', 'pulse'] },
                    title: { type: 'string', nullable: true },
                    scheduledAt: { type: 'string', format: 'date-time', nullable: true },
                    occurredAt: { type: 'string', format: 'date-time', nullable: true },
                    status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled'] },
                    sharedNotes: { type: 'string', nullable: true },
                    sentiment: { type: 'integer', nullable: true, minimum: 1, maximum: 5 },
                    items: { type: 'integer' },
                    actions: { type: 'integer' },
                    actionsCompleted: { type: 'integer' },
                },
            },
            CheckInItem: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    checkInId: { type: 'integer' },
                    body: { type: 'string' },
                    isAction: { type: 'boolean' },
                    done: { type: 'boolean' },
                    position: { type: 'integer' },
                },
            },
            Error: {
                type: 'object',
                properties: { error: { type: 'string' }, message: { type: 'string' } },
            },
        },
    },
    security: [{ sessionCookie: [] }, { apiKey: [] }],
    paths: {
        '/skills': {
            get: {
                summary: 'List skills (with domain)',
                parameters: [
                    {
                        name: 'limit',
                        in: 'query',
                        schema: { type: 'integer', default: 200, maximum: 1000 },
                    },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Skill' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    401: { description: 'Unauthenticated' },
                },
            },
        },
        '/employees': {
            get: {
                summary: 'RBAC-scoped employee directory (manager/admin)',
                parameters: [
                    {
                        name: 'limit',
                        in: 'query',
                        schema: { type: 'integer', default: 200, maximum: 1000 },
                    },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Employee' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Forbidden' },
                },
            },
        },
        '/employees/{id}/goals': {
            get: {
                summary: "List an employee's goals/OKRs (RBAC-guarded)",
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Goal' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Access denied' },
                },
            },
        },
        '/goals': {
            post: {
                summary: 'Create a goal/key-result (RBAC-guarded by target employee)',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['employeeId', 'title'],
                                properties: {
                                    employeeId: { type: 'integer' },
                                    title: { type: 'string' },
                                    kind: { type: 'string', enum: ['objective', 'key_result'] },
                                    parentId: { type: 'integer' },
                                    metricUnit: { type: 'string' },
                                    targetValue: { type: 'number' },
                                    period: { type: 'string' },
                                    dueDate: { type: 'string', format: 'date' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: { data: { $ref: '#/components/schemas/Goal' } },
                                },
                            },
                        },
                    },
                    400: { description: 'Validation error' },
                    403: { description: 'Forbidden' },
                },
            },
        },
        '/goals/{id}/progress': {
            patch: {
                summary: 'Update goal progress / status (RBAC-guarded)',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    currentValue: { type: 'number' },
                                    status: {
                                        type: 'string',
                                        enum: ['active', 'at_risk', 'done', 'cancelled'],
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: { data: { $ref: '#/components/schemas/Goal' } },
                                },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                },
            },
        },
        '/employees/{id}/check-ins': {
            get: {
                summary: "List an employee's check-ins / 1-on-1s (RBAC-guarded)",
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/CheckIn' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Access denied' },
                },
            },
        },
        '/check-ins': {
            post: {
                summary: 'Create a check-in / 1-on-1 (RBAC-guarded by target employee)',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['employeeId'],
                                properties: {
                                    employeeId: { type: 'integer' },
                                    managerId: { type: 'integer' },
                                    kind: {
                                        type: 'string',
                                        enum: ['one_on_one', 'feedback', 'pulse'],
                                    },
                                    title: { type: 'string' },
                                    scheduledAt: { type: 'string', format: 'date-time' },
                                    status: {
                                        type: 'string',
                                        enum: ['scheduled', 'completed', 'cancelled'],
                                    },
                                    sharedNotes: { type: 'string' },
                                    sentiment: { type: 'integer', minimum: 1, maximum: 5 },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: { data: { $ref: '#/components/schemas/CheckIn' } },
                                },
                            },
                        },
                    },
                    400: { description: 'Validation error' },
                    403: { description: 'Forbidden' },
                },
            },
        },
        '/check-ins/{id}': {
            patch: {
                summary: 'Update a check-in (status / outcome / notes / sentiment) (RBAC-guarded)',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    status: {
                                        type: 'string',
                                        enum: ['scheduled', 'completed', 'cancelled'],
                                    },
                                    occurredAt: { type: 'string', format: 'date-time' },
                                    sharedNotes: { type: 'string' },
                                    sentiment: { type: 'integer', minimum: 1, maximum: 5 },
                                    title: { type: 'string' },
                                    scheduledAt: { type: 'string', format: 'date-time' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: { data: { $ref: '#/components/schemas/CheckIn' } },
                                },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                },
            },
        },
        '/check-ins/{id}/items': {
            get: {
                summary: "List a check-in's agenda / action items (RBAC-guarded)",
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/CheckInItem' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Access denied' },
                },
            },
            post: {
                summary: 'Add an agenda / action item to a check-in (RBAC-guarded)',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['body'],
                                properties: {
                                    body: { type: 'string' },
                                    isAction: { type: 'boolean' },
                                    position: { type: 'integer' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: { $ref: '#/components/schemas/CheckInItem' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'Validation error' },
                    403: { description: 'Forbidden' },
                },
            },
        },
        '/check-in-items/{id}': {
            patch: {
                summary: 'Mark a check-in action item done / not done (RBAC-guarded)',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['done'],
                                properties: { done: { type: 'boolean' } },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: { $ref: '#/components/schemas/CheckInItem' },
                                    },
                                },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                },
            },
        },
        '/talent/ninebox': {
            get: {
                summary: 'Latest approved 9-box placement per employee (RBAC-scoped)',
                parameters: [
                    {
                        name: 'limit',
                        in: 'query',
                        schema: { type: 'integer', default: 200, maximum: 1000 },
                    },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/NineBox' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Forbidden' },
                },
            },
        },
        '/readiness': {
            get: {
                summary: 'List employee role-readiness (RBAC-scoped to caller)',
                parameters: [
                    {
                        name: 'limit',
                        in: 'query',
                        schema: { type: 'integer', default: 200, maximum: 1000 },
                    },
                    { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Readiness' },
                                        },
                                        count: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Forbidden (manager/admin only)' },
                },
            },
        },
        '/employees/{id}/development': {
            get: {
                summary: 'Coaching/IDP/PIP for one employee (RBAC-guarded)',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: { $ref: '#/components/schemas/Development' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Access denied' },
                },
            },
        },
        '/employees/{id}/readiness': {
            get: {
                summary: 'Readiness for one employee (RBAC-guarded)',
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
                ],
                responses: {
                    200: {
                        description: 'OK',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        data: { $ref: '#/components/schemas/Readiness' },
                                    },
                                },
                            },
                        },
                    },
                    403: { description: 'Access denied' },
                    404: { description: 'Not found' },
                },
            },
        },
    },
};
