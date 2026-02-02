interface Perspective<Aspect, Subject> {
  // a Perspective reveals some Aspect of a reference Subject
  // reveal a different way of looking at a subject...
  reveal<Reference extends Subject>(reference: Reference): Aspect;
  // a Perspective imposes changes to its Aspect on a reference Subject
  // impose changes in perspective upon a subject...
  impose<Reference extends Subject>(reference: Reference, altered: Aspect): Reference;
}

function MakePerspective<Aspect, Subject>(perspective: Perspective<Aspect, Subject>) {
  return { ...perspective };
}

function MakePerspectiveOn<Subject>() {
  return {
    make<Aspect>(perspective: Perspective<Aspect, Subject>) {
      return perspective;
    },
    select<Key extends keyof Subject>(key: Key) {
      return MakePerspective<Subject[Key], Subject>({
        reveal: ({ [key]: value }) => value,
        impose: (reference, value) => ({ ...reference, [key]: value }),
      });
    },
  };
}

export {
  Perspective as Of,
  MakePerspective as make,
  MakePerspectiveOn as on,
};
