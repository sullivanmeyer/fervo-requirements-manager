#!/usr/bin/env python3
"""
Idempotent seed script — populates the Geoblock default system hierarchy.

Usage:
    make seed
    # or directly:
    docker compose exec api python scripts/seed_hierarchy.py

The script is safe to run multiple times. It checks (name, parent_id) before
inserting, so re-running will skip nodes that already exist.
"""
import os
import sys
from datetime import datetime

sys.path.insert(0, "/app")

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.environ["DATABASE_URL"]
engine = create_engine(DATABASE_URL)
Session = sessionmaker(bind=engine)

# Full Geoblock Powerblock hierarchy — PRD §3.2
HIERARCHY = {
    "name": "Geoblock Powerblock",
    "children": [
        {
            "name": "BrineTransfer Module",
            "children": [
                {"name": "Wellpad"},
                {"name": "Production Well Gathering Piping & Valves"},
                {"name": "Injection Pumps, VFDs & Motors"},
                {"name": "Injection Piping & Valves"},
            ],
        },
        {
            "name": "ThermalFlux Module",
            "children": [
                {"name": "Preheater"},
                {"name": "Vaporizer"},
                {"name": "Superheater"},
                {"name": "ThermalFlux Foundations & Valves"},
            ],
        },
        {
            "name": "HeatRejection Module",
            "children": [
                {
                    "name": "Air-Cooled Condenser (ACC)",
                    "children": [
                        {"name": "ACC Tube Bundles"},
                        {"name": "ACC Induced-Draft Fans & Motors"},
                        {"name": "ACC Headers & Nozzles"},
                        {"name": "ACC Structural Steel"},
                        {"name": "ACC VFDs"},
                    ],
                },
                {"name": "Recuperator"},
                {"name": "Feed Pumps & Feed Pump Motors"},
                {"name": "NCG Skid Connection"},
                {"name": "Cold-Side Working Fluid Piping & Valves"},
                {"name": "HeatRejection Structural Steel & Foundations"},
                {"name": "Plot Plan / Plant Layout"},
            ],
        },
        {
            "name": "Turbogen Module",
            "children": [
                {"name": "Turboexpander"},
                {"name": "Generator"},
                {"name": "Generator Circuit Breaker & Protection Relay"},
                {"name": "Oil Skid"},
                {"name": "Cooling Water Skid"},
                {"name": "Turbine Drain & Bypass Systems"},
                {"name": "Turbogen Foundations, Piping & Valves"},
            ],
        },
        {
            "name": "E-House Module",
            "children": [
                {"name": "13.8kV Bus Duct"},
                {"name": "Unit Auxiliary Transformers"},
                {"name": "Medium Voltage Switchgear"},
                {"name": "Power Cables & Wiring"},
                {"name": "Junction Boxes & Breakers"},
                {"name": "E-House Building"},
            ],
        },
        {
            "name": "Power Export Module",
            "children": [
                {"name": "Substation"},
                {"name": "Step-Up Transformer (HV Side)"},
                {"name": "Transmission Line"},
                {"name": "Protection & Relay Systems"},
                {"name": "Power Export Civil & Structural"},
            ],
        },
        {
            "name": "Control System Module",
            "children": [
                {"name": "PLC Architecture"},
                {"name": "HMI"},
                {"name": "I/O & Control Wiring"},
                {"name": "Instrumentation"},
                {"name": "Control Narratives"},
            ],
        },
        {
            "name": "Utilities Module",
            "children": [
                {"name": "Firewater System"},
                {"name": "Instrument Air / Compressed Air"},
                {"name": "CCTV"},
                {"name": "Weather Station"},
                {"name": "Permanent Buildings"},
            ],
        },
    ],
}


def insert_node(session, node_data, parent_id=None, sort_order=0):
    from models import HierarchyNode

    existing = (
        session.query(HierarchyNode)
        .filter_by(name=node_data["name"], parent_id=parent_id)
        .first()
    )

    if existing:
        node = existing
        print(f"  skip (exists): {node_data['name']}")
    else:
        node = HierarchyNode(
            name=node_data["name"],
            parent_id=parent_id,
            sort_order=sort_order,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        session.add(node)
        session.flush()  # Assign ID without committing so children can reference it
        print(f"  created: {node_data['name']}")

    for i, child_data in enumerate(node_data.get("children", [])):
        insert_node(session, child_data, parent_id=node.id, sort_order=i)


def main():
    session = Session()
    try:
        print("Seeding Geoblock Powerblock hierarchy...")
        insert_node(session, HIERARCHY)
        session.commit()
        print("\nSeed complete.")
    except Exception as exc:
        session.rollback()
        print(f"\nSeed failed: {exc}", file=sys.stderr)
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
