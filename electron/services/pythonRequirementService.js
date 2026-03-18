const path = require('path');
const fs = require('fs-extra');

const { compareVersions, formatVersion } = require('./commandService');

const DEFAULT_REQUIREMENT_STRATEGIES = [
  {
    kind: 'pyproject',
    file: 'pyproject.toml',
  },
  {
    kind: 'setup-cfg',
    file: 'setup.cfg',
  },
  {
    kind: 'setup-py',
    file: 'setup.py',
  },
];

function parseVersionParts(value) {
  return String(value || '')
    .trim()
    .split('.')
    .map((part) => Number.parseInt(part.replace(/[^0-9].*$/, ''), 10))
    .filter((part) => Number.isFinite(part));
}

function parseSpecifier(specifier) {
  return String(specifier || '')
    .split(',')
    .map((clause) => clause.trim())
    .filter(Boolean)
    .map((clause) => {
      const match = clause.match(/^(<=|>=|==|!=|~=|<|>)\s*([0-9][0-9A-Za-z_.-]*)$/);
      if (!match) {
        throw new Error(`Local AI Hub could not read the Python version rule "${clause}".`);
      }

      return {
        operator: match[1],
        version: parseVersionParts(match[2]),
      };
    });
}

function compatibleUpperBound(version) {
  if (version.length >= 3) {
    return [version[0], (version[1] || 0) + 1, 0];
  }

  return [(version[0] || 0) + 1, 0, 0];
}

function versionSatisfiesSpecifier(version, specifier) {
  const clauses = parseSpecifier(specifier);
  return clauses.every((clause) => {
    const comparison = compareVersions(version, clause.version);

    if (clause.operator === '>=') {
      return comparison >= 0;
    }

    if (clause.operator === '>') {
      return comparison > 0;
    }

    if (clause.operator === '<=') {
      return comparison <= 0;
    }

    if (clause.operator === '<') {
      return comparison < 0;
    }

    if (clause.operator === '==') {
      return comparison === 0;
    }

    if (clause.operator === '!=') {
      return comparison !== 0;
    }

    if (clause.operator === '~=') {
      return comparison >= 0 && compareVersions(version, compatibleUpperBound(clause.version)) < 0;
    }

    return true;
  });
}

function describePythonRequirement(requirement) {
  if (!requirement) {
    return 'a compatible Python 3 version';
  }

  if (requirement.kind === 'minor-list') {
    const versions = requirement.supportedMinors.map((minor) => `3.${minor}`).join(', ');
    return `Python ${versions}`;
  }

  return `Python ${requirement.specifier}`;
}

function detectPyprojectRequirement(content, strategy) {
  const match = content.match(/requires-python\s*=\s*["']([^"']+)["']/i);
  if (!match) {
    throw new Error('Local AI Hub could not find a requires-python entry in the tool metadata.');
  }

  return {
    kind: 'specifier',
    source: strategy.file,
    specifier: match[1].trim(),
  };
}

function detectAutomatic1111Requirement(content, strategy) {
  const minorsMatch = content.match(/supported_minors\s*=\s*\[([^\]]+)\]/);
  if (!minorsMatch) {
    throw new Error('Local AI Hub could not find Automatic1111\'s supported Python minors.');
  }

  const supportedMinors = minorsMatch[1]
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));

  if (supportedMinors.length === 0) {
    throw new Error('Local AI Hub could not read Automatic1111\'s supported Python minors.');
  }

  return {
    kind: 'minor-list',
    source: strategy.file,
    supportedMinors,
  };
}

function detectClassifiedPythonMinors(content, strategy) {
  const supportedMinors = [...content.matchAll(/Programming Language :: Python :: 3\.(\d+)/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value));

  if (!supportedMinors.length) {
    return null;
  }

  return {
    kind: 'minor-list',
    source: strategy.file,
    supportedMinors: [...new Set(supportedMinors)].sort((left, right) => left - right),
  };
}

function normalizeDetectedSpecifier(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function detectSetupCfgRequirement(content, strategy) {
  const match = content.match(/^[ \t]*python_requires\s*=\s*(.+)$/im);
  if (match?.[1]) {
    const specifier = normalizeDetectedSpecifier(match[1]);
    if (specifier) {
      return {
        kind: 'specifier',
        source: strategy.file,
        specifier,
      };
    }
  }

  const classifierRequirement = detectClassifiedPythonMinors(content, strategy);
  if (classifierRequirement) {
    return classifierRequirement;
  }

  throw new Error('Local AI Hub could not find a Python requirement in setup.cfg.');
}

function detectSetupPyRequirement(content, strategy) {
  const match = content.match(/python_requires\s*=\s*["']([^"']+)["']/i);
  if (match?.[1]) {
    return {
      kind: 'specifier',
      source: strategy.file,
      specifier: normalizeDetectedSpecifier(match[1]),
    };
  }

  const classifierRequirement = detectClassifiedPythonMinors(content, strategy);
  if (classifierRequirement) {
    return classifierRequirement;
  }

  throw new Error('Local AI Hub could not find a Python requirement in setup.py.');
}

function buildRequirementStrategies(manifest) {
  const manifestStrategies = manifest.installInstructions?.pythonRequirementDetection || manifest.pythonRequirementDetection || [];
  const seen = new Set();
  const ordered = [];

  for (const strategy of [...manifestStrategies, ...DEFAULT_REQUIREMENT_STRATEGIES]) {
    const kind = String(strategy?.kind || '').trim();
    const file = String(strategy?.file || '').trim();
    if (!kind || !file) {
      continue;
    }

    const key = `${kind}::${file.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    ordered.push({ kind, file });
  }

  return ordered;
}

async function readRequirementFromStrategy(appDir, strategy) {
  const filePath = path.join(appDir, strategy.file);
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const content = await fs.readFile(filePath, 'utf8');

  if (strategy.kind === 'pyproject') {
    return detectPyprojectRequirement(content, strategy);
  }

  if (strategy.kind === 'automatic1111-launch-utils') {
    return detectAutomatic1111Requirement(content, strategy);
  }

  if (strategy.kind === 'setup-cfg') {
    return detectSetupCfgRequirement(content, strategy);
  }

  if (strategy.kind === 'setup-py') {
    return detectSetupPyRequirement(content, strategy);
  }

  throw new Error(`Local AI Hub does not know how to inspect the Python rules from ${strategy.file}.`);
}

async function detectPythonRequirement(appDir, manifest, logger) {
  const explicitRequirement =
    manifest.installInstructions?.pythonRequirement ||
    manifest.pythonRequirement ||
    null;
  if (explicitRequirement) {
    const specifier = String(explicitRequirement).trim();
    if (!specifier) {
      throw new Error(`Local AI Hub could not read the Python rule for ${manifest.name}.`);
    }

    await logger.info('Python requirement was provided directly in the tool definition.', {
      requirement: specifier,
    });
    return {
      kind: 'specifier',
      source: 'manifest',
      specifier,
    };
  }

  const strategies = buildRequirementStrategies(manifest);
  for (const strategy of strategies) {
    try {
      const requirement = await readRequirementFromStrategy(appDir, strategy);
      if (!requirement) {
        continue;
      }

      await logger.info('Python requirement detected from the downloaded tool files.', {
        source: requirement.source,
        requirement: requirement.kind === 'minor-list' ? requirement.supportedMinors : requirement.specifier,
      });
      return requirement;
    } catch (error) {
      await logger.warn('A Python requirement strategy did not resolve a usable version rule. Trying the next metadata file.', {
        strategy,
        error,
      });
    }
  }

  throw new Error(
    `Local AI Hub could not determine which Python version ${manifest.name} needs from its downloaded files.`,
  );
}

function versionSatisfiesRequirement(version, requirement) {
  if (!requirement) {
    return true;
  }

  if (requirement.kind === 'minor-list') {
    return requirement.supportedMinors.includes(version[1]);
  }

  return versionSatisfiesSpecifier(version, requirement.specifier);
}

function isCompatibleRuntime(runtime, requirement) {
  return versionSatisfiesRequirement(runtime.version, requirement);
}

function requirementToLabel(requirement) {
  if (!requirement) {
    return 'compatible Python 3';
  }

  if (requirement.kind === 'minor-list') {
    return requirement.supportedMinors.map((minor) => `3.${minor}`).join(' or ');
  }

  return requirement.specifier;
}

module.exports = {
  describePythonRequirement,
  detectPythonRequirement,
  isCompatibleRuntime,
  parseSpecifier,
  parseVersionParts,
  requirementToLabel,
  versionSatisfiesRequirement,
};