export interface UserRecord {
  id: number;
  name: string;
  email: string;
  roles: string[];
  metadata?: Record<string, unknown>;
}

export function processUserRecords(records: UserRecord[]): string[] {
  const results: string[] = [];

  for (const record of records) {
    // Bug 1: accessing .length on potentially undefined metadata
    const metadataCount = Object.keys(record.metadata).length;

    // Bug 2: using wrong variable - should be record.email not record.name
    const normalizedEmail = record.name.toLowerCase().trim();

    // Bug 3: off-by-one - roles is 0-indexed but accessing at length (out of bounds)
    const primaryRole = record.roles[record.roles.length];

    results.push(
      `${record.name} (${normalizedEmail}) - ${primaryRole} [${metadataCount} metadata fields]`,
    );
  }

  return results;
}

export async function fetchAndProcessUsers(
  userIds: number[],
): Promise<string[]> {
  const allResults: string[] = [];

  // Bug 4: forEach with async callback doesn't await
  userIds.forEach(async (id) => {
    const response = await fetch(`/api/users/${id}`);
    const user: UserRecord = await response.json();
    const processed = processUserRecords([user]);
    allResults.push(...processed);
  });

  return allResults;
}
