let currentAssessment = null;
let currentLevel = null;

// Escape user-supplied text before injecting via innerHTML (prevents stored XSS
// from free-text assessment notes etc.).
function smEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// Runtime strings. index.ejs injects window.SM_I18N in the session language;
// this file keeps the English wording as the fallback, so a key that is missing
// degrades to English rather than to a blank label.
function smT(key, fallback) {
    const v = window.SM_I18N && window.SM_I18N[key];
    return typeof v === 'string' && v ? v : fallback;
}

// Positional {0}/{1} interpolation, the same contract dashboard.js uses.
function smFmt(template, ...args) {
    return String(template == null ? '' : template).replace(/\{(\d+)\}/g, (m, i) =>
        args[i] === undefined || args[i] === null ? m : String(args[i])
    );
}

// The 0-4 scale in the session language. ONE source: the modal tooltip and the
// Quick Edit dropdown each carried their own identical English array.
function smLevels() {
    const l = window.SM_I18N && window.SM_I18N.levels;
    return Array.isArray(l) && l.length === 5
        ? l
        : ['None', 'Basic Awareness', 'Guided', 'Autonomous', 'Expert'];
}

// Load readiness stats. The search box is bound ONCE, at the bottom of this
// file; there is no second binding here.
document.addEventListener('DOMContentLoaded', function () {
    updateReadinessStats();
});

function openAssessmentModal(employeeId, skillId, employeeName, skillName, domainName) {
    currentAssessment = { employeeId, skillId };
    document.getElementById('modalEmployeeId').value = employeeId;
    document.getElementById('modalSkillId').value = skillId;
    document.getElementById('modalEmployeeName').textContent = employeeName;
    document.getElementById('modalSkillName').textContent = skillName;
    document.getElementById('modalDomainName').textContent = domainName;

    // Get current assessment level
    const cell = document.querySelector(
        `td.skill-cell[data-employee-id="${employeeId}"][data-skill-id="${skillId}"]`
    );
    const currentLevelDiv = cell ? cell.querySelector('.skill-level') : null;
    const currentLevelVal = currentLevelDiv ? parseInt(currentLevelDiv.textContent.trim()) : 0;

    selectLevel(currentLevelVal);
    document.getElementById('assessmentNotes').value = '';

    // Check for role requirement
    const row = document.querySelector(`tr[data-employee-id="${employeeId}"]`);
    const roleId = row ? row.dataset.roleId : null;

    // Fetch requirement info (client-side from DOM). Null-safe: never let a
    // missing optional element abort opening the modal.
    const reqInfo = document.getElementById('requirementInfo');
    const reqType = document.getElementById('requirementType');
    const reqLevelDisp = document.getElementById('requiredLevelDisplay');
    const requirementBadge = cell ? cell.querySelector('.requirement-badge') : null;
    const requiredLevel = requirementBadge
        ? requirementBadge.getAttribute('data-required-level') || ''
        : '';

    if (requirementBadge && requiredLevel) {
        const isCritical = requirementBadge.classList.contains('critical');
        if (reqType) reqType.textContent = isCritical ? 'CRITICAL' : 'required';
        if (reqLevelDisp) reqLevelDisp.textContent = requiredLevel;
        if (reqInfo) reqInfo.style.display = 'block';
    } else if (reqInfo) {
        reqInfo.style.display = 'none';
    }

    showModal('assessmentModal');
}

function selectLevel(level) {
    currentLevel = level;
    document.getElementById('selectedLevel').value = level;

    // Update button states
    document.querySelectorAll('.level-btn').forEach((btn) => {
        btn.classList.remove('selected');
        if (parseInt(btn.dataset.level) === level) {
            btn.classList.add('selected');
        }
    });
}

// Form submission
const assessmentForm = document.getElementById('assessmentForm');
if (assessmentForm) {
    assessmentForm.addEventListener('submit', function (e) {
        e.preventDefault();

        if (currentLevel === null || currentLevel === undefined) {
            alert(smT('selectLevel', 'Please select a skill level.'));
            return;
        }

        const formData = new FormData(this);
        const data = {
            employeeId: formData.get('employeeId'),
            skillId: formData.get('skillId'),
            currentLevel: parseInt(formData.get('currentLevel')),
            notes: formData.get('notes') || null,
            _csrf: formData.get('_csrf'),
        };

        showLoading(smT('saving', 'Saving assessment…'));

        fetch(`/employees/${data.employeeId}/assessments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })
            .then((res) => res.json())
            .then((result) => {
                hideLoading();
                if (result.success) {
                    hideModal('assessmentModal');
                    // Update UI without reload
                    updateCellUI(data.employeeId, data.skillId, data.currentLevel);
                    if (result.readiness) {
                        updateReadinessUI(data.employeeId, result.readiness);
                    }
                    // Show success toast or message
                    // (Optional)
                } else {
                    // The server's own message is already localised; the key is
                    // the fallback for a refusal that carries no message.
                    alert(result.error || smT('saveFailed', 'Could not save the assessment.'));
                }
            })
            .catch((error) => {
                hideLoading();
                console.error('Error:', error);
                alert(smT('saveFailed', 'Could not save the assessment.'));
            });
    });
}

function toggleCompactView() {
    const table = document.getElementById('matrixTable');
    const toggle = document.getElementById('viewToggle');

    // innerHTML, not textContent: the button ships a Font Awesome <i>, and
    // writing textContent used to delete it and leave a bare emoji behind.
    const label = table.classList.toggle('compact')
        ? smT('expandedView', 'Expanded View')
        : smT('compactView', 'Compact View');
    toggle.innerHTML = `<i class="fas fa-chart-column" aria-hidden="true"></i> ${smEsc(label)}`;
}

function exportMatrix() {
    const table = document.getElementById('matrixTable');
    const rows = Array.from(table.querySelectorAll('tr'));

    let csv = [];

    rows.forEach((row, index) => {
        // Skip hidden rows
        if (row.style.display === 'none') return;

        const cells = Array.from(row.querySelectorAll('th, td'));
        const rowData = cells.map((cell) => {
            let text = cell.innerText.replace(/\n/g, ' ').trim();

            // Special handling for skill cells to get just the number
            if (cell.classList.contains('skill-cell')) {
                const levelDiv = cell.querySelector('.skill-level');
                text = levelDiv ? levelDiv.textContent.trim() : '0';
            }
            return `"${text.replace(/"/g, '""')}"`;
        });
        csv.push(rowData.join(','));
    });

    const csvContent = csv.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'skill_matrix_export_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    window.URL.revokeObjectURL(url);
}

function updateCellUI(employeeId, skillId, level) {
    const cell = document.querySelector(
        `td.skill-cell[data-employee-id="${employeeId}"][data-skill-id="${skillId}"]`
    );
    if (!cell) return;

    const levelDiv = cell.querySelector('.skill-level');
    if (levelDiv) {
        // Remove old level classes
        levelDiv.classList.remove('level-0', 'level-1', 'level-2', 'level-3', 'level-4', 'not-met');

        // Add new level class
        levelDiv.classList.add(`level-${level}`);
        levelDiv.textContent = level;

        // Check if requirement is met
        const badge = cell.querySelector('.requirement-badge');
        if (badge) {
            const requiredLevel = parseInt(badge.getAttribute('data-required-level'));
            if (!isNaN(requiredLevel) && level < requiredLevel) {
                levelDiv.classList.add('not-met');
            }
        }

        // Update title tooltip roughly
        const titles = smLevels();
        let newTitle = smFmt(
            smT('levelTitle', 'Level {0}: {1}'),
            level,
            titles[level] || smT('levelUnknown', 'Unknown')
        );
        if (badge) {
            const requiredLevel = badge.getAttribute('data-required-level');
            newTitle += `\n${smT('requiredColon', 'Required:')} ${requiredLevel}`;
        }
        levelDiv.title = newTitle;
    }
}

function updateReadinessUI(employeeId, readiness) {
    // Find readiness cell for this employee
    // We can find the row first
    const row = document.querySelector(`tr[data-employee-id="${employeeId}"]`);
    if (!row) return;

    const readinessCell = row.querySelector('.readiness-cell');
    if (!readinessCell) return;

    const indicator = readinessCell.querySelector('.readiness-indicator');
    if (indicator) {
        // Update class
        indicator.classList.remove('ready', 'not-ready');
        indicator.classList.add(readiness.isReady ? 'ready' : 'not-ready');

        // Update percent. readinessPercent is readiness_assessed_only — null
        // (never 0) when nothing has ever been assessed.
        const pct =
            readiness.readinessPercent == null
                ? smT('notMeasured', 'Not measured')
                : `${readiness.readinessPercent}%`;
        const percentDiv = indicator.querySelector('.readiness-percent');
        if (percentDiv) percentDiv.textContent = pct;

        // Update status text
        const statusDiv = indicator.querySelector('.readiness-status');
        if (statusDiv) {
            statusDiv.textContent = readiness.isReady
                ? `✓ ${smT('ready', 'Ready')}`
                : `✗ ${smT('notReady', 'Not Ready')}`;
        }

        // Update tooltip
        let title = `${smT('readinessColon', 'Readiness:')} ${pct}`;
        if (readiness.gaps && readiness.gaps.length > 0) {
            title += `\n${smT('gapsColon', 'Gaps:')} ${readiness.gaps.length}`;
        }
        indicator.title = title;
    }

    // Update dashboard stats if visible
    updateReadinessStats();
}

function applyFilters() {
    const siteName = document.getElementById('filterSite').value;
    const deptName = document.getElementById('filterDepartment').value;
    const serviceName = document.getElementById('filterService').value;
    const roleName = document.getElementById('filterRole').value;
    const readiness = document.getElementById('filterReadiness').value;
    const searchTerm = document.getElementById('employeeSearch').value.toLowerCase();

    const rows = document.querySelectorAll('#matrixTable tbody tr');
    let visibleCount = 0;
    let readyCount = 0;

    rows.forEach((row) => {
        // Skip separator rows
        if (row.classList.contains('site-separator')) {
            // Logic to hide separators if all their children are hidden?
            // For now, just keep them or hide based on site filter?
            // Simple approach: hide separators if site filter is active and doesn't match?
            // Actually, separators are tricky. Let's just filter employee rows first.
            return;
        }

        const employeeSiteName = row.getAttribute('data-site-name');
        const employeeDeptName = row.getAttribute('data-department-name');
        const employeeServiceName = row.getAttribute('data-service-name');
        const employeeRoleName = row.getAttribute('data-role-name');
        const employeeName = row.getAttribute('data-employee-name');
        const employeeNumber = row.getAttribute('data-employee-number');

        // Readiness check
        const readinessIndicator = row.querySelector('.readiness-indicator');
        const isReady = readinessIndicator && readinessIndicator.classList.contains('ready');

        let show = true;

        if (siteName && employeeSiteName !== siteName) show = false;
        if (deptName && employeeDeptName !== deptName) show = false;
        if (serviceName && employeeServiceName !== serviceName) show = false;
        if (roleName && employeeRoleName !== roleName) show = false;
        if (readiness === 'ready' && !isReady) show = false;
        if (readiness === 'not-ready' && isReady) show = false;

        if (
            searchTerm &&
            !employeeName.includes(searchTerm) &&
            !employeeNumber.includes(searchTerm)
        ) {
            show = false;
        }

        row.style.display = show ? '' : 'none';

        if (show) {
            visibleCount++;
            if (isReady) readyCount++;
        }
    });

    // Handle separators (optional polish)
    document.querySelectorAll('.site-separator').forEach((sep) => {
        if (siteName) {
            // If filtering by specific site, probably hide all separators or just show the relevant one?
            // Simpler: Hide all separators when filtering by site to avoid clutter
            sep.style.display = 'none';
        } else {
            sep.style.display = '';
        }
    });

    // Update stats
    updateStatsDisplay(visibleCount, readyCount);
}

function updateReadinessStats() {
    // Re-run filter logic to update stats based on current visibility
    // Or just count visible rows
    const rows = document.querySelectorAll('#matrixTable tbody tr:not(.site-separator)');
    let visibleCount = 0;
    let readyCount = 0;

    rows.forEach((row) => {
        if (row.style.display !== 'none') {
            visibleCount++;
            const indicator = row.querySelector('.readiness-indicator');
            if (indicator && indicator.classList.contains('ready')) {
                readyCount++;
            }
        }
    });

    updateStatsDisplay(visibleCount, readyCount);
}

function updateStatsDisplay(visible, ready) {
    const totalEl = document.getElementById('filteredCount');
    const readyEl = document.getElementById('readyCount');

    if (totalEl) totalEl.textContent = visible;
    if (readyEl) readyEl.textContent = ready;
}

// Add event listener for search input
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('employeeSearch');
    if (searchInput) {
        searchInput.addEventListener('input', applyFilters);
    }
});

// Delegated click handler for skill cells. Previously every cell carried a verbose
// inline onclick with the employee/skill/domain names interpolated — for a wide
// matrix that bloated the page (≈1KB/cell). We now resolve those names from a
// one-time header map + the row, so cells stay tiny and the page loads fast.
document.addEventListener('DOMContentLoaded', () => {
    const table = document.getElementById('matrixTable');
    if (!table) return;
    // skillId -> { name, domain } from the skill header row.
    const skillMeta = {};
    table.querySelectorAll('th.skill-header[data-skill-id]').forEach((th) => {
        skillMeta[th.dataset.skillId] = {
            name:
                th.dataset.skillName ||
                (th.querySelector('.skill-name')
                    ? th.querySelector('.skill-name').textContent.trim()
                    : ''),
            domain: th.dataset.domainName || '',
        };
    });
    table.addEventListener('click', (e) => {
        const cell = e.target.closest('td.skill-cell');
        if (!cell || !table.contains(cell)) return;
        // In Quick Edit mode, don't open a fresh inline editor if one is already active in this cell.
        if (cell.querySelector('.qe-select')) return;
        const skillId = cell.dataset.skillId;
        const row = cell.closest('tr[data-employee-id]');
        if (!row) return;
        const employeeId = row.dataset.employeeId;
        if (window.__quickEdit) {
            openInlineEditor(cell, Number(employeeId), Number(skillId));
            return;
        }
        const employeeName = (row.dataset.empName || '').trim();
        const meta = skillMeta[skillId] || { name: '', domain: '' };
        openAssessmentModal(
            Number(employeeId),
            Number(skillId),
            employeeName,
            meta.name,
            meta.domain
        );
    });
});

// --- Quick Edit: inline 0-4 dropdown per cell, saves via the existing single-cell endpoint. ---
window.__quickEdit = false;
function toggleQuickEdit() {
    window.__quickEdit = !window.__quickEdit;
    const btn = document.getElementById('quickEditToggle');
    const table = document.getElementById('matrixTable');
    if (btn) {
        btn.setAttribute('aria-pressed', window.__quickEdit ? 'true' : 'false');
        btn.classList.toggle('btn-primary', window.__quickEdit);
        btn.classList.toggle('btn-secondary', !window.__quickEdit);
        const label = window.__quickEdit
            ? smT('quickEditOn', 'Quick Edit: On')
            : smT('quickEditOff', 'Quick Edit: Off');
        btn.innerHTML = `<i class="fas fa-bolt" aria-hidden="true"></i> ${smEsc(label)}`;
    }
    if (table) table.classList.toggle('quick-edit', window.__quickEdit);
}

function smCsrf() {
    const f = document.querySelector('#assessmentForm input[name="_csrf"]');
    if (f) return f.value;
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : '';
}

function openInlineEditor(cell, employeeId, skillId) {
    const levelDiv = cell.querySelector('.skill-level');
    const cur = levelDiv ? parseInt(levelDiv.textContent.trim()) || 0 : 0;
    const LABELS = smLevels();
    const sel = document.createElement('select');
    sel.className = 'qe-select';
    for (let i = 0; i <= 4; i++) {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = i + ' · ' + LABELS[i];
        if (i === cur) o.selected = true;
        sel.appendChild(o);
    }
    const content = cell.querySelector('.skill-cell-content') || cell;
    content.style.visibility = 'hidden';
    cell.appendChild(sel);
    sel.focus();
    const cleanup = () => {
        sel.remove();
        content.style.visibility = '';
    };
    sel.addEventListener('change', () => {
        const level = parseInt(sel.value);
        sel.disabled = true;
        saveCell(employeeId, skillId, level, cleanup);
    });
    sel.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') cleanup();
    });
    sel.addEventListener('blur', () => {
        setTimeout(() => {
            if (document.body.contains(sel) && !sel.disabled) cleanup();
        }, 120);
    });
}

function saveCell(employeeId, skillId, level, done) {
    fetch(`/employees/${employeeId}/assessments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            employeeId,
            skillId,
            currentLevel: level,
            notes: null,
            _csrf: smCsrf(),
        }),
    })
        .then((res) => res.json())
        .then((result) => {
            if (result.success) {
                updateCellUI(employeeId, skillId, level);
                if (result.readiness) updateReadinessUI(employeeId, result.readiness);
            } else {
                alert(result.error || smT('saveFailed', 'Could not save the assessment.'));
            }
        })
        .catch(() => alert(smT('saveFailed', 'Could not save the assessment.')))
        .finally(() => {
            if (done) done();
        });
}

function switchModalTab(tabName) {
    // Update tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
    event.target.classList.add('active');

    // Update content
    document
        .querySelectorAll('.tab-content')
        .forEach((content) => content.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'history') {
        loadHistory();
    }
}

function loadHistory() {
    if (!currentAssessment) return;

    const container = document.getElementById('historyList');
    const loading = document.getElementById('historyLoading');

    container.innerHTML = '';
    loading.style.display = 'block';

    fetch(
        `/employees/${currentAssessment.employeeId}/assessments/history/${currentAssessment.skillId}`
    )
        .then((res) => res.json())
        .then((data) => {
            loading.style.display = 'none';
            if (data.history && data.history.length > 0) {
                const html = data.history
                    .map(
                        (item) => `
                    <div class="history-item">
                        <div class="history-header">
                            <span class="history-level level-${item.currentLevel}">${item.currentLevel}</span>
                            <span class="history-date">${window.FMT ? window.FMT.date(item.assessedAt) : String(item.assessedAt || '').slice(0, 10)}</span>
                        </div>
                        <div class="history-notes">${item.notes ? smEsc(item.notes) : smEsc(smT('noNotes', 'No notes'))}</div>
                        <div class="history-meta">${smEsc(smFmt(smT('byAdmin', 'By admin #{0}'), item.assessedBy))}</div>
                    </div>
                `
                    )
                    .join('');
                container.innerHTML = html;
            } else {
                container.innerHTML = `<p class="no-history">${smEsc(smT('noHistory', 'No history found for this skill.'))}</p>`;
            }
        })
        .catch((err) => {
            console.error(err);
            loading.style.display = 'none';
            container.innerHTML = `<p class="error">${smEsc(smT('historyError', 'Could not load the history.'))}</p>`;
        });
}
