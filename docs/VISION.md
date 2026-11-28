# KINUX: the development environment for physical engineering

Master vision, architecture and research brief. This is the reference every technical and product
decision is checked against. It was written by the project owner on 2026-11-28 and is kept here verbatim
in substance. Commentary and decisions live in `docs/PHASE0-SPEC.md` and
`docs/DETERMINISM-PLAN.md`.

## 1. The vision

We are building KINUX, an integrated development environment (IDE) for physical engineering. Our
ambition is to create for physical machines what programming languages, compilers and development
environments created for software.

Software engineers can describe complex applications in programming languages, compile them into
executable software, then test, debug and deploy them. Physical engineering has no equivalent
unified environment. Mechanical CAD, electronics design, embedded programming, physics simulation,
robotics, structural analysis, verification and manufacturing are handled through separate tools,
file formats and workflows. KINUX aims to bring these disciplines together into one coherent,
programmable engineering ecosystem.

**Make physical machines programmable.** An engineer should be able to describe a machine three ways:
- in a dedicated engineering programming language;
- by building it visually with CAD tools;
- by describing it to an AI agent in natural language.

All three operate on the same underlying engineering representation. The result is a coherent model
that can be analysed, simulated, verified and prepared for manufacturing.

## 2. The core concept: a physical engineering programming language

KINUX should eventually have its own domain-specific language for describing complete physical
systems, going beyond parametric CAD and 3D modelling. It should express:
- geometry and dimensions;
- components and assemblies;
- materials and physical properties;
- coordinate systems and transformations;
- connections, joints and constraints;
- electrical circuits and power systems;
- motors, actuators and sensors;
- embedded firmware and control logic;
- behaviour and dynamics;
- functional requirements and engineering constraints;
- manufacturing processes and tolerances;
- testing, verification and inspection requirements.

Illustrative syntax (conceptual, not a specification):

```
machine RoboticArm:
    structure:
        body Base:
            geometry = cylinder(radius = 100 mm, height = 50 mm)
            material = Aluminium_6061
        body UpperArm:
            geometry = box(length = 400 mm, width = 40 mm, height = 30 mm)
            material = Aluminium_7075
        body Forearm:
            geometry = box(length = 350 mm, width = 35 mm, height = 25 mm)
    connections:
        joint J1: type = revolute; connects = Base -> UpperArm
        joint J2: type = revolute; connects = UpperArm -> Forearm
    actuators:
        motor M1: drives = J1
        motor M2: drives = J2
    requirements:
        payload >= 2 kg
        reach >= 500 mm
        collision_free = true
    engineering:
        calculate_mass(); calculate_dynamics(); analyse_stress(); simulate_motion(); verify_requirements()
    manufacturing:
        generate_CAD(); generate_BOM(); generate_drawings()
```

The formal grammar, semantics, type system and APIs must be designed and tested.

## 3. The physical engineering compiler

The pipeline:

engineering language → KINUX compiler → unified machine representation → engineering solvers → physical engineering outputs

The compiler should:
1. Parse the language.
2. Perform syntax and semantic analysis.
3. Check units and dimensional consistency.
4. Check references and structural relationships.
5. Validate constraints and requirements.
6. Translate the source into an intermediate representation.
7. Coordinate the engineering solvers.
8. Generate artifacts.
9. Report errors, warnings, assumptions and verification results.

It coordinates existing and future specialist solvers through a common architecture; it does not replace them.

## 4. Universal Machine Representation (UMR)

UMR is a proposed concept, not an industry standard.

**M = (G, P, C, E, B, R, M_f)**:
- **G:** geometry;
- **P:** physical properties and materials;
- **C:** connections, topology and constraints;
- **E:** energy, electrical and power systems;
- **B:** behaviour, control and dynamics;
- **R:** functional and engineering requirements;
- **M_f:** manufacturing specifications.

The representation must support:
- hierarchical assemblies and typed components;
- coordinate frames;
- parametric relationships;
- units;
- materials and constitutive properties;
- mechanical and electrical interfaces;
- constraints and dependencies;
- control relationships;
- manufacturing metadata;
- versioning and traceability;
- uncertainty and assumptions;
- verification status and solver provenance.

**The key requirement:** visual CAD, programmatic engineering and AI interaction all operate on the
same underlying representation.

## 5. Three ways to create machines

**A. Visual.** Build components and assemblies, define joints and constraints, assign materials,
connect electronics, configure motors and sensors, and inspect results.

**B. Programmatic.** The KINUX language, with:
- physical types and dimensional analysis;
- parametric geometry;
- assemblies and constraints;
- behaviour, requirements and manufacturing specifications;
- reusable libraries.

**C. AI-native.** For example: "Design a two-link robotic arm with a payload of 2 kg and a reach of 500 mm."
The AI should:
- interpret the requirements and identify what's missing;
- generate KINUX programs;
- work with the representation and call engineering tools;
- interpret compiler and simulation errors;
- suggest alternatives and explain trade-offs.

All three update the same engineering model.

## 6. The engineering kernel

The kernel must be deterministic. It provides or integrates:
- **Geometry:** solid, parametric, booleans, surfaces and meshes, transformations.
- **Physical systems:** materials, mass and inertia, constraints, kinematics and dynamics, energy.
- **Analysis:** structural, thermal, fluids, electromagnetics, circuits, multibody dynamics.
- **Robotics:** kinematics, joints, actuators, sensors, control, collisions.
- **Electronics and firmware:** circuits, PCBs, embedded software, hardware/software interfaces.

Research candidates (not final selections):

| Area | Candidates |
|---|---|
| Geometry and CAD | Open CASCADE, FreeCAD, OpenSCAD |
| Scenes and system modelling | OpenUSD, Modelica |
| Structural analysis | CalculiX, Code_Aster |
| Simulation and robotics | Project Chrono, NVIDIA Isaac Sim, Gazebo, URDF/SDF |
| Electronics | KiCad |

Their licensing, APIs, suitability and integration cost must be evaluated before any is chosen.

## 7. Simulation, verification and validation

A visually plausible model is not a physically valid design.

**Simulation covers:** kinematics, dynamics, structure, heat, electrical behaviour, collisions,
actuators and control response.

**Verification checks the design against its requirements,** for example
`payload >= 2 kg`, `reach >= 500 mm`, `maximum_temperature <= 60 degC`, `motor_current <= 10 A`.

**Results must be traceable,** showing:
- requirements met and requirements violated;
- the assumptions used;
- solver and model versions;
- numerical limits and uncertainty;
- missing information;
- what needs physical testing.

Reproducible computation does not imply physical correctness. Validity boundaries must be defined.

## 8. Manufacturing compiler

**Outputs:** STEP, STL, DXF, drawings, BOM, material and tolerance specifications, assembly
instructions, process information, inspection requirements, and firmware and electronics documentation.

**It must consider:** CNC, additive, sheet metal, conventional machining, assembly, material
availability, machine capabilities, tolerances and inspection.

## 9. KINUX × Antropi Robotics

Antropi develops autonomous CNC manufacturing.

**The proposed split:**
- **KINUX (upstream):** language, representation, CAD, analysis, simulation, verification and
  manufacturing preparation.
- **Antropi:** manufacturing workflow, CNC, robotic handling, operations, inspection and feedback.

**The workflow:**
1. An engineer describes a machine in KINUX.
2. KINUX builds its representation.
3. KINUX produces CAD and documentation.
4. KINUX checks the constraints.
5. The engineer submits to Antropi.
6. Antropi manufactures.
7. Inspection results return to KINUX.
8. KINUX links the measurements to the design.
9. The next revision improves.

**This must be validated directly with Antropi.** Do not assume an API, an agreement or demand exists.

## 10. AI and the developer ecosystem

KINUX must not assume models are pretrained on it. It provides:
- complete documentation and machine-readable schemas;
- examples;
- compiler and tool APIs;
- structured errors;
- discoverable capabilities;
- SDKs and MCP;
- versioned specifications;
- validation suites.

**The AI generates; the deterministic compiler and engines enforce semantics and evaluate.**

## 11. Software architecture

| # | Component | Role |
|---|---|---|
| 1 | IDE | The development environment |
| 2 | Language | The physical engineering language |
| 3 | Compiler | Parser and translation engine |
| 4 | UMR | The unified machine representation |
| 5 | Core | The engineering kernel and solver coordination |
| 6 | Simulation | Physical simulation and digital twins |
| 7 | Verification | Requirements and validation |
| 8 | Manufacturing | Manufacturing documentation and integrations |
| 9 | AI | The engineering assistant and agent interface |
| 10 | SDK | The external developer ecosystem |

The boundaries must let each component evolve independently.

## 12. Roadmap

| Phase | Name | Covers |
|---|---|---|
| 0 | Research | Ontology, existing representations, first machine category, technical specification |
| 1 | UMR | Schema, component and assembly models, types and units, versioning and dependencies |
| 2 | Kernel | Geometry engines, coordinates and constraints, materials, solver interfaces |
| 3 | Language and compiler | Grammar, parser and semantic checker, dimensional types, translation to UMR |
| 4 | IDE | Editor, explorer, CAD viewport, assembly tree, properties, console, interactive editing |
| 5 | Simulation | Kinematics, dynamics, collisions, actuators, control |
| 6 | Verification | Requirements engine, constraint validation, traceability, reports |
| 7 | Physical prototype | Manufacture, compare with measurements, find limits, improve the kernel |
| 8 | Electronics and firmware | PCB, power, firmware, sensors and actuators |
| 9 | Manufacturing ecosystem | Manufacturing compiler, fabrication integrations, capability data, inspection feedback |
| 10 | AI-native engineering | Generated programs, compiler-in-the-loop design, multi-agent workflows, SDK and MCP |

## 13. First proof of concept

A **two-link robotic arm**. It should demonstrate:
- parametric components, materials and geometry;
- assembly and joints;
- motors;
- requirements;
- CAD generation;
- kinematics and dynamics, and simulation;
- basic verification;
- BOM and drawings.

Then manufacture it and compare real behaviour with the model.

## 14. Research questions

1. The limits of existing CAD and engineering platforms.
2. Existing languages for physical systems.
3. What a universal machine representation should contain.
4. Whether one IR can connect mechanical, electrical and control systems without losing discipline information.
5. How to handle physical laws, constraints and uncertainty.
6. What is deterministic, and what is numerical approximation.
7. How solvers communicate.
8. How CAD, PCB, firmware and simulation stay synchronised.
9. Safe, reliable AI–compiler interaction.
10. The minimum viable engineering kernel.
11. What makes KINUX genuinely different.
12. The smallest working product that shows the vision.
13. Integration with Antropi and other manufacturers.
14. What should be open source, proprietary or an API.

Do not assume KINUX is the first such attempt. Study Modelica, SysML, OpenSCAD, URDF, VHDL, CAD
kernels, digital-twin platforms and systems-engineering tools. Differentiation must come from the
quality and coherence of the whole architecture, not from new syntax.

## 15. Mission

KINUX should become the programmable development environment for the physical world.

human or AI intent → KINUX language → UMR → engineering compiler → simulation and verification → manufacturing → physical machine

Every decision is judged by whether it makes this workflow possible, reliable and useful.
