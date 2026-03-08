const path = require('path');
const fs = require('fs-extra');

const { compareVersions, formatVersion } = require('./commandService');

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
        throw new Error(`NestAI could not read the Python version rule \"${clause}\".`);
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
    throw new Error('NestAI could not find a requires-python entry in the tool metadata.');
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
    throw new Error('NestAI could not find Automatic1111\'s supported Python minors.');
  }

  const supportedMinors = minorsMatch[1]
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));

  if (supportedMinors.length === 0) {
    throw new Error('NestAI could not read Automatic1111\'s supported Python minors.');
  }

  return {
    kind: 'minor-list',
    source: strategy.file,
    supportedMinors,
  };
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

  throw new Error(`NestAI does not know how to inspect the Python rules from ${strategy.file}.`);
}

async function detectPythonRequirement(appDir, manifest, logger) {
  const strategies = manifest.installInstructions?.pythonRequirementDetection || manifest.pythonRequirementDetection || [];
  for (const strategy of strategies) {
    const requirement = await readRequirementFromStrategy(appDir, strategy);
    if (!requirement) {
      continue;
    }

    await logger.info('Python requirement detected from the downloaded tool files.', {
      source: requirement.source,
      requirement: requirement.kind === 'minor-list' ? requirement.supportedMinors : requirement.specifier,
    });
    return requirement;
  }

  throw new Error(
    `NestAI could not determine which Python version ${manifest.name} needs from its downloaded files.`,
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

